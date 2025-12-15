const socket = io();

const connBadge = document.getElementById("connBadge");
const logDiv = document.getElementById("serverLog");
function log(msg) {
  const p = document.createElement("div");
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logDiv.prepend(p);
}

socket.on("connect", () => {
  connBadge.textContent = "Connected";
  connBadge.classList.remove("badge--off");
  connBadge.classList.add("badge--on");
  sendParams();
});

socket.on("disconnect", () => {
  connBadge.textContent = "Disconnected";
  connBadge.classList.remove("badge--on");
  connBadge.classList.add("badge--off");
});

socket.on("server_msg", (data) => log(data.msg));
socket.on("hr_update", (data) => {
  hrDisplay.textContent = `HR: ${data.hr.toFixed(0)} BPM`;
});

document.getElementById("helloBtn").addEventListener("click", () => {
  socket.emit("hello_server", { name: "CardioFusion client" });
});

const camBtn = document.getElementById("camBtn");
const camStatus = document.getElementById("camStatus");
const video = document.getElementById("video");
const hrDisplay = document.getElementById("hrDisplay");

let videoStream;
let ppgProcessor;
let frameProcessorHandle;

const canvas = document.createElement("canvas");
canvas.width = 320;
canvas.height = 240;
const ctx = canvas.getContext("2d", { willReadFrequently: true });

camBtn.addEventListener("click", async () => {
  try {
    if (!videoStream) {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, frameRate: { ideal: 30 } },
        audio: false
      });
      video.srcObject = videoStream;
      await video.play();
      
      ppgProcessor = createPPGProcessor({ frameRate: 30 });
      frameProcessorHandle = setInterval(processFrames, 1000 / 30); 

      camStatus.textContent = "Camera active ✔";
      camBtn.textContent = "Stop Camera";
    } else {
      videoStream.getTracks().forEach(track => track.stop());
      videoStream = null;
      video.srcObject = null;
      clearInterval(frameProcessorHandle);
      camStatus.textContent = "Camera off";
      camBtn.textContent = "Start Camera";
      hrDisplay.textContent = "HR: -- BPM";
    }
  } catch (err) {
    console.error(err);
    camStatus.textContent = "Camera error: " + (err.message || err);
  }
});

function processFrames() {
  if (!videoStream || video.paused || video.ended || !ppgProcessor) {
    return;
  }
  
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  
  let greenSum = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    greenSum += imageData[i + 1]; 
  }
  const greenAvg = greenSum / (imageData.length / 4);

  const ppgData = ppgProcessor.process(greenAvg);
  
  if (ppgData && ppgData.hr) {
    socket.emit("ppg_data", ppgData);
  }
}

function createPPGProcessor({ frameRate }) {
  const bufferSize = frameRate * 5; 
  const detrendedSignal = [];
  const peakTimestamps = [];
  
  const emaAlpha = 0.1;
  let ema = null;
  
  const refractoryPeriod = (60 / 200) * frameRate; 
  let framesSinceLastPeak = 0;
  const peakThreshold = 0.2; 

  return {
    process(value) {
      if (ema === null) {
        ema = value;
      }
      ema = emaAlpha * value + (1 - emaAlpha) * ema;
      const detrended = value - ema;
      
      detrendedSignal.push(detrended);
      if (detrendedSignal.length > bufferSize) {
        detrendedSignal.shift();
      }
      
      framesSinceLastPeak++;
      if (framesSinceLastPeak < refractoryPeriod) {
        return null;
      }

      const n = detrendedSignal.length;
      if (n < 3) return null;
      
      const isPeak = detrendedSignal[n - 2] > detrendedSignal[n - 3] &&
                     detrendedSignal[n - 2] > detrendedSignal[n - 1] &&
                     detrendedSignal[n - 2] > peakThreshold;

      if (isPeak) {
        framesSinceLastPeak = 0;
        peakTimestamps.push(Date.now());
        if (peakTimestamps.length > 10) {
          peakTimestamps.shift();
        }
        return this.calculateHR();
      }
      return null;
    },
    
    calculateHR() {
      if (peakTimestamps.length < 2) {
        return null;
      }
      
      const intervals = [];
      for (let i = 1; i < peakTimestamps.length; i++) {
        intervals.push(peakTimestamps[i] - peakTimestamps[i - 1]);
      }
      
      const avgIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avgIntervalMs === 0) return null;

      const hr = 60000 / avgIntervalMs;
      
      if (hr < 40 || hr > 180) return null; 
      
      const intervalStdDev = Math.sqrt(
        intervals.map(x => Math.pow(x - avgIntervalMs, 2)).reduce((a, b) => a + b, 0) / intervals.length
      );
      
      const quality = Math.max(0, 1 - (intervalStdDev / avgIntervalMs));

      return { hr, quality };
    }
  };
}

const modeSelect = document.getElementById("mode");
const lrlRange = document.getElementById("lrl");
const lrlValue = document.getElementById("lrlValue");

function sendParams() {
  const params = {
    mode: modeSelect.value,
    lrl: lrlRange.value
  };
  socket.emit("set_params", params);
}

modeSelect.addEventListener("change", sendParams);
lrlRange.addEventListener("input", () => {
  lrlValue.textContent = lrlRange.value;
});
lrlRange.addEventListener("change", sendParams);

const vitalHR = document.getElementById("vitalHR");
const vitalMode = document.getElementById("vitalMode");
const vitalLRL = document.getElementById("vitalLRL");
const vitalState = document.getElementById("vitalState");

const ecgCanvas = document.getElementById("ecgCanvas");
const ecgCtx = ecgCanvas.getContext("2d");
const egmCanvas = document.getElementById("egmCanvas");
const egmCtx = egmCanvas.getContext("2d");

const canvasWidth = ecgCanvas.width;
const canvasHeight = ecgCanvas.height;

const ecgBuffer = new Array(canvasWidth).fill(canvasHeight / 2);
const egmBuffer = new Array(canvasWidth).fill(canvasHeight / 2);

const ecgColor = "#059669";
const egmColor = "#3b82f6";

socket.on("vitals_update", (data) => {
  vitalHR.textContent = data.hr.toFixed(0);
  vitalMode.textContent = data.mode;
  vitalLRL.textContent = data.lrl;
  vitalState.textContent = data.state;

  let ecgPoint = (canvasHeight / 2) - (data.ecg * (canvasHeight / 3));
  ecgBuffer.push(ecgPoint);
  if (ecgBuffer.length > canvasWidth) {
    ecgBuffer.shift();
  }
  
  let egmPoint = (canvasHeight / 2) - (data.egm * (canvasHeight / 3));
  egmBuffer.push(egmPoint);
  if (egmBuffer.length > canvasWidth) {
    egmBuffer.shift();
  }
  
  drawECG();
  drawEGM();
});

function drawECG() {
  ecgCtx.fillStyle = "#000000";
  ecgCtx.fillRect(0, 0, canvasWidth, canvasHeight);
  ecgCtx.beginPath();
  ecgCtx.strokeStyle = ecgColor;
  ecgCtx.lineWidth = 2;
  ecgCtx.moveTo(0, ecgBuffer[0]);
  for (let i = 1; i < canvasWidth; i++) {
    ecgCtx.lineTo(i, ecgBuffer[i]);
  }
  ecgCtx.stroke();
}

function drawEGM() {
  egmCtx.fillStyle = "#000000";
  egmCtx.fillRect(0, 0, canvasWidth, canvasHeight);
  egmCtx.beginPath();
  egmCtx.strokeStyle = egmColor;
  egmCtx.lineWidth = 2;
  egmCtx.moveTo(0, egmBuffer[0]);
  for (let i = 1; i < canvasWidth; i++) {
    egmCtx.lineTo(i, egmBuffer[i]);
  }
  egmCtx.stroke();
}
from flask import Flask, render_template
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from models import db, Patient, Vitals
import logging
import time

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "dev"
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///../cardiofusion.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

logging.getLogger('werkzeug').setLevel(logging.ERROR)

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

class Pacemaker:
    def __init__(self):
        self.mode = "VVI"
        self.lrl = 60
        self.last_pace_time = 0
        self.last_intrinsic_time = 0
        self.v_interval = 60000 / self.lrl
        
        self.patient_hr = 45
        self.patient_interval = 60000 / self.patient_hr
        
        self.current_hr = self.lrl
        self.pacing_state = 'IDLE'

    def set_params(self, data):
        self.lrl = int(data.get('lrl', self.lrl))
        self.mode = data.get('mode', self.mode)
        self.v_interval = 60000 / self.lrl

    def set_patient_hr(self, hr):
        if hr > 30 and hr < 200:
            self.patient_hr = hr
            self.patient_interval = 60000 / self.patient_hr

    def update(self, current_time):
        time_since_last_pace = current_time - self.last_pace_time
        time_since_last_intrinsic = current_time - self.last_intrinsic_time

        ecg_value = 0.0
        egm_value = 0.0
        event = 'NONE'

        if time_since_last_intrinsic > self.patient_interval:
            self.last_intrinsic_time = current_time
            time_since_last_intrinsic = 0
            
            if self.mode == "VVI" and time_since_last_pace < self.v_interval:
                self.current_hr = self.patient_hr
                event = 'INTRINSIC'
            elif self.mode != "VVI":
                self.current_hr = self.patient_hr
                event = 'INTRINSIC'

        if self.mode == "VVI":
            if time_since_last_pace > self.v_interval:
                if time_since_last_intrinsic > 200:
                    self.last_pace_time = current_time
                    self.current_hr = self.lrl
                    event = 'VPACE'
        
        if event == 'VPACE':
            ecg_value = 1.0
            egm_value = -0.8
            self.pacing_state = 'VPACE'
        elif event == 'INTRINSIC':
            ecg_value = 0.8
            egm_value = 0.6
            self.pacing_state = 'VSENSE'
        
        return {
            'ecg': ecg_value,
            'egm': egm_value,
            'hr': self.current_hr,
            'state': self.pacing_state,
            'lrl': self.lrl,
            'mode': self.mode,
            'event': event
        }

pacer = Pacemaker()
active_patient = None

def simulator_loop():
    global active_patient
    
    with app.app_context():
        if not active_patient:
            active_patient = Patient.query.first()
            if not active_patient:
                active_patient = Patient(name="Default Patient")
                db.session.add(active_patient)
                db.session.commit()

    while True:
        current_time_ms = int(time.time() * 1000)
        vitals = pacer.update(current_time_ms)
        
        socketio.emit('vitals_update', vitals)
        
        if vitals['event'] != 'NONE':
            with app.app_context():
                new_vital = Vitals(
                    hr=vitals['hr'], 
                    mode=vitals['mode'], 
                    lrl=vitals['lrl'],
                    patient_id=active_patient.id
                )
                db.session.add(new_vital)
                db.session.commit()

        socketio.sleep(0.05)


@app.route("/")
def index():
    return render_template("index.html")

@socketio.on("connect")
def handle_connect():
    global active_patient
    with app.app_context():
        active_patient = Patient.query.first()
    emit("server_msg", {"msg": "Server ready ✅"})

@socketio.on("hello_server")
def on_hello(data):
    emit("server_msg", {"msg": f"Hello back, {data.get('name','client')}!"})

@socketio.on("ppg_data")
def handle_ppg(data):
    hr = data.get('hr', 0)
    pacer.set_patient_hr(hr)
    socketio.emit("hr_update", data)

@socketio.on("set_params")
def on_set_params(data):
    pacer.set_params(data)
    emit("server_msg", {"msg": f"Params set: LRL={data['lrl']}, Mode={data['mode']}"})

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
        if not Patient.query.first():
            db.session.add(Patient(name="Default Patient"))
            db.session.commit()
    
    socketio.start_background_task(simulator_loop)
    print("Starting CardioFusion server at http://127.0.0.1:5000 ...")
    socketio.run(app, host="127.0.0.1", port=5000, debug=True, allow_unsafe_werkzeug=True, use_reloader=False)
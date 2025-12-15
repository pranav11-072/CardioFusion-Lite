from flask_sqlalchemy import SQLAlchemy
import datetime

db = SQLAlchemy()

class Patient(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, default='Default Patient')
    vitals = db.relationship('Vitals', backref='patient', lazy=True)

class Vitals(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)
    hr = db.Column(db.Float, nullable=True)
    mode = db.Column(db.String(10), nullable=True)
    lrl = db.Column(db.Integer, nullable=True)
    patient_id = db.Column(db.Integer, db.ForeignKey('patient.id'), nullable=False)
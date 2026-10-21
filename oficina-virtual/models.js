import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const ref = m => ({ type: Schema.Types.ObjectId, ref: m });

export const User = model('User', new Schema({
  nombre: String, telefono: String,
  email: { type: String, unique: true, lowercase: true },
  password: String,
  role: { type: String, enum: ['admin', 'presidente', 'director', 'coordinador', 'encargado', 'caja', 'ciudadano'], default: 'ciudadano' },
  department: ref('Department'), parent: ref('User'),
  correoVerificado: { type: Boolean, default: false }, sinCorreos: Boolean, resetHash: String, resetExp: Date, verifHash: String, consentimiento: Date,
  activo: { type: Boolean, default: true }
}, { timestamps: true }));

export const Department = model('Department', new Schema({ nombre: String, director: ref('User') }));

export const Category = model('Category', new Schema({
  nombre: String, subcategorias: [String], department: ref('Department'), slaHoras: { type: Number, default: 48 }
}));

export const Procedure = model('Procedure', new Schema({
  nombre: String, descripcion: String, department: ref('Department'),
  requisitos: [{ nombre: String, obligatorio: { type: Boolean, default: true } }],
  costo: { tipo: { type: String, default: 'fijo' }, monto: { type: Number, default: 0 }, fundamento: String },
  costoPendiente: { monto: Number, por: ref('User') },
  historialCostos: [{ monto: Number, por: ref('User'), fecha: Date }],
  campos: [{ id: String, label: String, tipo: String, obligatorio: Boolean, opciones: [String] }], etapas: [String],
  slaDias: { type: Number, default: 5 }, activo: { type: Boolean, default: true }
}));

// Un "caso" es un reporte ciudadano o un trámite: comparten flujo, folio, jerarquía e historial.
export const Case = model('Case', new Schema({
  folio: { type: String, unique: true }, tipo: { type: String, enum: ['reporte', 'tramite'] },
  ciudadano: ref('User'), department: ref('Department'), category: ref('Category'), subcategoria: String, procedure: ref('Procedure'),
  titulo: String, descripcion: String, datos: Schema.Types.Mixed,
  ubicacion: { lat: Number, lng: Number, texto: String }, fotos: [String], documentos: [{ nombre: String, data: String }], transferencia: { claveRastreo: String, fecha: String, comprobante: String, motivo: String, revisadoPor: ref('User'), enviadoEn: Date }, costo: Number, etapa: { type: Number, default: 0 }, cuenta: ref('Cuenta'), evidencias: [{ foto: String, lat: Number, lng: Number, nota: String, por: ref('User'), fecha: { type: Date, default: Date.now } }],
  estatus: { type: String, default: 'Recibido' },
  asignadoA: ref('User'), coordinador: ref('User'), director: ref('User'),
  slaVence: Date, nivelEscalado: { type: Number, default: 0 }, cerradoEn: Date, calificacion: Number,
  historial: [{ estatus: String, por: ref('User'), nota: String, fecha: { type: Date, default: Date.now } }],
  hilo: [{ autor: ref('User'), rol: String, texto: String, interno: Boolean, fecha: { type: Date, default: Date.now } }]
}, { timestamps: true }));

export const Counter = model('Counter', new Schema({ _id: String, n: Number }));
export const Notification = model('Notification', new Schema({ user: ref('User'), texto: String, caso: ref('Case'), leida: { type: Boolean, default: false } }, { timestamps: true }));
export const Message = model('Message', new Schema({ canal: String, de: ref('User'), texto: String, circular: Boolean, leidoPor: [ref('User')] }, { timestamps: true }));
export const Audit = model('Audit', new Schema({ user: ref('User'), accion: String, detalle: Schema.Types.Mixed }, { timestamps: true }));

export const Payment = model('Payment', new Schema({
  folio: String, caso: ref('Case'), casoFolio: String, concepto: String, ciudadano: ref('User'), department: ref('Department'),
  monto: Number, referencia: String, metodo: { type: String, enum: ['tarjeta', 'spei', 'efectivo', 'mercadopago'] }
}, { timestamps: true }));

export const Aviso = model('Aviso', new Schema({
  titulo: String, texto: String, zona: String, tipo: { type: String, enum: ['aviso', 'obra', 'alerta'], default: 'aviso' }, autor: ref('User'), activo: { type: Boolean, default: true }
}, { timestamps: true }));

export const Obra = model('Obra', new Schema({ nombre: String, descripcion: String, department: ref('Department'), presupuesto: Number, avance: { type: Number, default: 0 }, estatus: { type: String, default: 'En proceso' }, zona: String, lat: Number, lng: Number }, { timestamps: true }));
export const Sesion = model('Sesion', new Schema({ titulo: String, fecha: Date, tipo: { type: String, default: 'Ordinaria' }, resumen: String, videoUrl: String }, { timestamps: true }));
export const Cita = model('Cita', new Schema({ ciudadano: ref('User'), department: ref('Department'), tramite: String, fecha: String, hora: String, recordada: Boolean, estatus: { type: String, default: 'Programada' } }, { timestamps: true }));

export const Inhabil = model('Inhabil', new Schema({ fecha: { type: String, unique: true }, motivo: String }));

export const Cuenta = model('Cuenta', new Schema({ tipo: { type: String, enum: ['predial', 'agua'] }, clave: String, titular: String, direccion: String, adeudo: { type: Number, default: 0 }, ciudadano: ref('User'), ultimoPago: Date }));
export const Propuesta = model('Propuesta', new Schema({ titulo: String, descripcion: String, autor: ref('User'), apoyos: [ref('User')], estatus: { type: String, default: 'Abierta' }, respuesta: String }, { timestamps: true }));
export const Proyecto = model('Proyecto', new Schema({ titulo: String, descripcion: String, costo: Number, votos: [ref('User')] }, { timestamps: true }));
export const Ronda = model('Ronda', new Schema({ abierta: Boolean, presupuesto: Number, votosPorPersona: { type: Number, default: 3 } }));
export const Activo = model('Activo', new Schema({ tipo: String, codigo: { type: String, unique: true }, descripcion: String, department: ref('Department'), zona: String, lat: Number, lng: Number, estado: { type: String, default: 'Operando' }, ultimaAtencion: Date }));

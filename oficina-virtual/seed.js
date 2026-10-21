import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User, Department, Category, Procedure } from './models.js';

await mongoose.connect(process.env.MONGODB_URI);
if (await User.findOne({ role: 'admin' })) { console.log('Ya estaba inicializado'); if (!process.env.DEMO) process.exit(0); }
const password = await bcrypt.hash(process.env.SEED_PASSWORD || 'CambiaEstaClave123', 10);
await User.create({ nombre: 'Administrador', email: 'admin@municipio.gob.mx', password, role: 'admin' });
await User.create({ nombre: 'Presidente Municipal', email: 'presidente@municipio.gob.mx', password, role: 'presidente' });
const D = {};
for (const n of ['Servicios Públicos', 'Agua Potable', 'Obras Públicas', 'Protección Civil', 'Secretaría del Ayuntamiento']) D[n] = (await Department.create({ nombre: n }))._id;
await Category.insertMany([
  { nombre: 'Alumbrado público', subcategorias: ['Lámpara apagada', 'Poste dañado'], department: D['Servicios Públicos'], slaHoras: 72 },
  { nombre: 'Basura y limpieza', subcategorias: ['Recolección', 'Tiradero clandestino'], department: D['Servicios Públicos'], slaHoras: 48 },
  { nombre: 'Parques y jardines', subcategorias: [], department: D['Servicios Públicos'], slaHoras: 96 },
  { nombre: 'Fuga de agua', subcategorias: ['En la calle', 'En toma domiciliaria'], department: D['Agua Potable'], slaHoras: 24 },
  { nombre: 'Drenaje', subcategorias: ['Azolve', 'Registro dañado'], department: D['Agua Potable'], slaHoras: 48 },
  { nombre: 'Baches y calles', subcategorias: [], department: D['Obras Públicas'], slaHoras: 96 },
  { nombre: 'Emergencia o riesgo', subcategorias: ['Árbol caído', 'Inundación'], department: D['Protección Civil'], slaHoras: 4 }
]);
await Procedure.insertMany([
  { nombre: 'Constancia de residencia', descripcion: 'Documento que acredita tu domicilio en el municipio.', department: D['Secretaría del Ayuntamiento'], requisitos: [{ nombre: 'Identificación oficial' }, { nombre: 'Comprobante de domicilio' }], costo: { tipo: 'fijo', monto: 80 }, slaDias: 3 },
  { nombre: 'Licencia de construcción', descripcion: 'Permiso para construir o ampliar.', department: D['Obras Públicas'], requisitos: [{ nombre: 'Escritura o título de propiedad' }, { nombre: 'Planos' }, { nombre: 'Identificación oficial' }], costo: { tipo: 'variable', monto: 0 }, slaDias: 15 }
]);
console.log('Listo. Ingresa con presidente@municipio.gob.mx y la clave de SEED_PASSWORD, y cámbiala.');
if (!process.env.DEMO) process.exit(0);

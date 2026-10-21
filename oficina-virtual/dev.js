// Modo demo: base de datos temporal en memoria. No necesita MongoDB Atlas ni Render.
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('oficina_demo');
process.env.SEED_PASSWORD = 'Demo12345';
process.env.DEMO = '1';
process.env.CLABE = '000000000000000000';
process.env.BANCO = 'Banco de demostración';
process.env.TITULAR = 'Municipio de Demostración (datos ficticios)';
process.env.MUNICIPIO = 'H. Ayuntamiento de Demostración';
process.env.LEMA = 'Trabajando contigo, por nuestra gente';

await import('./seed.js');
const { User, Department } = await import('./models.js');
const password = await bcrypt.hash('Demo12345', 10);
const agua = await Department.findOne({ nombre: 'Agua Potable' });
const dir = await User.create({ nombre: 'Director de Agua', email: 'director@demo.mx', password, role: 'director', department: agua._id });
agua.director = dir._id; await agua.save();
const coord = await User.create({ nombre: 'Coordinador de Agua', email: 'coordinador@demo.mx', password, role: 'coordinador', department: agua._id, parent: dir._id });
const enc = await User.create({ nombre: 'Encargado de Agua', email: 'encargado@demo.mx', password, role: 'encargado', department: agua._id, parent: coord._id });
const cit = await User.create({ nombre: 'Ciudadano de Prueba', email: 'ciudadano@demo.mx', password, role: 'ciudadano' });

const sec = await Department.findOne({ nombre: 'Secretaría del Ayuntamiento' });
await User.create({ nombre: 'Encargada de Secretaría', email: 'secretaria@demo.mx', password, role: 'encargado', department: sec._id });
await User.create({ nombre: 'Tesorería (Caja)', email: 'caja@demo.mx', password, role: 'caja' });
const { Case, Category, Payment } = await import('./models.js');
const cats = await Category.find({ department: agua._id });
const est = ['Asignado', 'En proceso', 'Resuelto', 'Asignado', 'En proceso', 'Cerrado', 'Asignado', 'En proceso'];
for (let i = 0; i < 8; i++) await Case.create({ folio: `REP-2026-9${String(i).padStart(5, '0')}`, tipo: 'reporte', ciudadano: cit._id, department: agua._id, category: cats[i % cats.length]._id, titulo: cats[i % cats.length].nombre, descripcion: 'Reporte de ejemplo para la demostración.', ubicacion: { lat: 19.43 + (Math.random() - .5) * .04, lng: -99.13 + (Math.random() - .5) * .04, texto: 'Calle de ejemplo' }, estatus: est[i], asignadoA: enc._id, coordinador: coord._id, director: dir._id, slaVence: new Date(Date.now() + (i % 3 ? 1 : -1) * 864e5), historial: [{ estatus: est[i], por: cit._id, nota: 'Ejemplo' }] });
for (const [i, m] of ['tarjeta', 'spei', 'efectivo', 'tarjeta'].entries()) await Payment.create({ folio: `PAG-2026-9${String(i).padStart(5, '0')}`, casoFolio: 'TRA-2026-000001', concepto: 'Constancia de residencia', ciudadano: cit._id, department: agua._id, monto: 80 * (i + 1), metodo: m });
const { Aviso } = await import('./models.js');
await Aviso.insertMany([
  { titulo: 'Corte de agua programado', texto: 'Este sábado de 8:00 a 14:00 habrá mantenimiento en la red de la zona centro.', tipo: 'alerta' },
  { titulo: 'Nueva ventanilla digital', texto: 'Ya puedes tramitar constancias y pagar en línea sin hacer filas.', tipo: 'aviso' },
  { titulo: 'Obra: pavimentación en avenida principal', texto: 'Avance del 60%. Se recomienda usar rutas alternas.', tipo: 'obra' }
]);
const { Obra, Sesion } = await import('./models.js');
const obrasD = await Department.find({ nombre: 'Obras Públicas' });
await Obra.insertMany([
  { nombre: 'Pavimentación avenida principal', department: obrasD[0]._id, presupuesto: 4500000, avance: 60, zona: 'Centro' },
  { nombre: 'Rehabilitación de red de agua potable', department: agua._id, presupuesto: 2100000, avance: 35, zona: 'Colonia Norte' },
  { nombre: 'Alumbrado LED en parque municipal', department: obrasD[0]._id, presupuesto: 850000, avance: 100, zona: 'Parque Central', estatus: 'Concluida' }
]);
await Sesion.insertMany([
  { titulo: 'Aprobación del programa anual de obra', fecha: new Date(Date.now() - 6 * 864e5), tipo: 'Ordinaria', resumen: 'Se aprobó el programa de obra pública del ejercicio.' },
  { titulo: 'Convenio de colaboración con el estado', fecha: new Date(Date.now() - 20 * 864e5), tipo: 'Extraordinaria', resumen: 'Firma de convenio para servicios de agua y drenaje.' }
]);
const { Cuenta, Proyecto, Ronda, Propuesta, Activo } = await import('./models.js');
await Cuenta.insertMany([{ tipo: 'predial', clave: 'ABC123456', titular: 'Ciudadano de Prueba', direccion: 'Calle Reforma 10', adeudo: 1250 }, { tipo: 'agua', clave: 'AG-5521', titular: 'Ciudadano de Prueba', direccion: 'Calle Reforma 10', adeudo: 340 }]);
await Proyecto.insertMany([{ titulo: 'Cancha techada en la colonia Norte', descripcion: 'Espacio deportivo para jóvenes.', costo: 900000 }, { titulo: 'Luminarias solares en caminos rurales', descripcion: 'Más seguridad por las noches.', costo: 450000 }, { titulo: 'Biblioteca comunitaria', descripcion: 'Acervo y talleres.', costo: 600000 }]);
await Ronda.create({ abierta: true, presupuesto: 2000000, votosPorPersona: 2 });
await Propuesta.create({ titulo: 'Reductores de velocidad frente a la escuela', descripcion: 'Los autos pasan muy rápido a la hora de salida.', autor: cit._id });
await Activo.insertMany([{ tipo: 'luminaria', codigo: 'LUM-001', zona: 'Centro', estado: 'Falla', department: agua._id }, { tipo: 'pozo', codigo: 'POZ-014', zona: 'Norte', estado: 'Operando', department: agua._id }]);
console.log('\nDEMO LISTA -> http://localhost:3000');
console.log('Todas las cuentas usan la clave Demo12345:');
console.log('  presidente@municipio.gob.mx | director@demo.mx | coordinador@demo.mx | encargado@demo.mx | ciudadano@demo.mx | secretaria@demo.mx | caja@demo.mx\n');
await import('./server.js');

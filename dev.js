// Modo demo: base de datos temporal en memoria. No necesita MongoDB Atlas ni Render.
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('oficina_demo');
process.env.SEED_PASSWORD = 'Demo12345';
process.env.DEMO = '1';
process.env.DESCUENTO_PRONTO_PAGO = '50';
process.env.DIAS_PRONTO_PAGO = '5';
process.env.CLABE = '000000000000000000';
process.env.BANCO = 'Banco de ejemplo';
process.env.TITULAR = 'Municipio (datos de ejemplo)';
process.env.MUNICIPIO = 'Ayuntamiento Municipal';
process.env.SIN_CLAVE = 'true';
process.env.LEMA = 'Gobierno cercano a ti';

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
  { nombre: 'Pavimentación de avenida principal', department: obrasD[0]._id, presupuesto: 4500000, avance: 60, zona: 'Centro' },
  { nombre: 'Rehabilitación de red de agua potable', department: agua._id, presupuesto: 2100000, avance: 35, zona: 'Colonia Norte' },
  { nombre: 'Alumbrado LED en parque municipal', department: obrasD[0]._id, presupuesto: 850000, avance: 100, zona: 'Parque Central', estatus: 'Concluida' }
]);
await Sesion.insertMany([
  { titulo: 'Aprobación del programa anual de obra', fecha: new Date(Date.now() - 6 * 864e5), tipo: 'Ordinaria', resumen: 'Se aprobó el programa de obra pública del ejercicio.' },
  { titulo: 'Convenio de colaboración con el estado', fecha: new Date(Date.now() - 20 * 864e5), tipo: 'Extraordinaria', resumen: 'Firma de convenio para servicios de agua y drenaje.' }
]);
const obr = obrasD[0], serv = await Department.findOne({ nombre: 'Servicios Públicos' });
const dirO = await User.create({ nombre: 'Director de Obras', email: 'obras@demo.mx', password, role: 'director', department: obr._id });
obr.director = dirO._id; await obr.save();
const encO = await User.create({ nombre: 'Encargado de Obras', email: 'encargado.obras@demo.mx', password, role: 'encargado', department: obr._id, parent: dirO._id });
const catsO = await Category.find({ department: { $in: [obr._id, serv._id] } });
const est2 = ['Asignado', 'En proceso', 'Resuelto', 'Asignado', 'En proceso', 'Resuelto', 'Asignado', 'En proceso', 'Cerrado', 'Asignado'];
for (let i = 0; i < 10; i++) { const c = catsO[i % catsO.length], d = String(c.department) === String(obr._id) ? obr : serv; await Case.create({ folio: `REP-2026-8${String(i).padStart(5, '0')}`, tipo: 'reporte', ciudadano: cit._id, department: d._id, category: c._id, titulo: c.nombre, descripcion: 'Reporte de ejemplo.', ubicacion: { lat: 19.43 + (Math.random() - .5) * .05, lng: -99.13 + (Math.random() - .5) * .05 }, estatus: est2[i], asignadoA: d === obr ? encO._id : undefined, director: d.director, slaVence: new Date(Date.now() + (i % 2 ? 1 : -2) * 864e5), historial: [{ estatus: est2[i], por: cit._id, nota: 'Ejemplo' }] }); }
await User.create({ nombre: 'Agente de Tránsito', email: 'agente@demo.mx', password, role: 'agente' });
const { Egreso, Presupuesto, Payment: Pay2 } = await import('./models.js');
await User.create({ nombre: 'Tesorero Municipal', email: 'tesorero@demo.mx', password, role: 'tesorero' });
const todos = await Department.find(), yy = new Date().getFullYear(), mes = (n, d = 10) => { const x = new Date(); x.setDate(d); x.setMonth(x.getMonth() - n); return x; };
for (const [i, dp] of todos.entries()) await Presupuesto.create({ anio: yy, department: dp._id, monto: [1500000, 900000, 2400000, 600000, 700000, 500000, 400000, 350000][i % 8] });
const RB = ['Nómina', 'Materiales y suministros', 'Obra pública', 'Combustible', 'Mantenimiento', 'Servicios básicos', 'Apoyos sociales', 'Servicios profesionales'];
for (let i = 0; i < 14; i++) { const st = i < 8 ? 'Pagado' : i < 10 ? 'Autorizado' : i < 13 ? 'Solicitado' : 'Rechazado'; await Egreso.create({ folio: `EGR-${yy}-9${String(i).padStart(5, '0')}`, concepto: ['Pago de nómina quincenal', 'Compra de tubería PVC', 'Pavimentación de calle', 'Diésel para unidades', 'Mantenimiento de camión recolector', 'Recibo de energía eléctrica', 'Despensas para familias', 'Asesoría contable'][i % 8], proveedor: ['Nómina municipal', 'Ferretería (ejemplo)', 'Constructora (ejemplo)', 'Gasolinera (ejemplo)', 'Taller mecánico (ejemplo)', 'CFE', 'Proveedora Social', 'Despacho contable'][i % 8], rubro: RB[i % 8], department: todos[i % todos.length]._id, monto: 15000 + i * 7300, fecha: mes(i % 5), estatus: st, motivo: st === 'Rechazado' ? 'Sin soporte documental' : undefined, solicitadoPor: dir._id, autorizadoPor: st === 'Solicitado' ? undefined : dirO._id, pagadoEn: st === 'Pagado' ? mes(i % 5, 20) : undefined, referenciaPago: st === 'Pagado' ? 'SPEI' + (100000 + i) : undefined }); }
for (let i = 1; i < 6; i++) await Pay2.create({ folio: `PAG-${yy}-8${i}`, casoFolio: 'TRA-DEMO', concepto: 'Cobros del mes', ciudadano: cit._id, department: agua._id, monto: 60000 + i * 11000, metodo: 'spei', referencia: 'DEMO' + i, createdAt: mes(i) });
const { Cuenta, Proyecto, Ronda, Propuesta, Activo } = await import('./models.js');
await Cuenta.insertMany([{ tipo: 'predial', clave: 'ABC123456', titular: 'Ciudadano de Prueba', direccion: 'Calle Principal 10', adeudo: 1250 }, { tipo: 'agua', clave: 'AG-5521', titular: 'Ciudadano de Prueba', direccion: 'Calle Principal 10', adeudo: 340 }]);
await Proyecto.insertMany([{ titulo: 'Cancha techada en una colonia', descripcion: 'Espacio deportivo para jóvenes.', costo: 900000 }, { titulo: 'Luminarias solares en caminos rurales', descripcion: 'Más seguridad por las noches.', costo: 450000 }, { titulo: 'Biblioteca comunitaria', descripcion: 'Acervo y talleres.', costo: 600000 }]);
await Ronda.create({ abierta: true, presupuesto: 2000000, votosPorPersona: 2 });
await Propuesta.create({ titulo: 'Reductores de velocidad frente a la escuela', descripcion: 'Los autos pasan muy rápido a la hora de salida.', autor: cit._id });
await Activo.insertMany([{ tipo: 'luminaria', codigo: 'LUM-001', zona: 'Centro', estado: 'Falla', department: agua._id }, { tipo: 'pozo', codigo: 'POZ-014', zona: 'Norte', estado: 'Operando', department: agua._id }]);
console.log('\nDEMO LISTA -> http://localhost:3000');
console.log('MODO DE PRUEBA: entra con cualquiera de estas cuentas dejando la contraseña EN BLANCO:');
console.log('  presidente@municipio.gob.mx | director@demo.mx | coordinador@demo.mx | encargado@demo.mx | ciudadano@demo.mx | secretaria@demo.mx | caja@demo.mx | obras@demo.mx | tesorero@demo.mx | agente@demo.mx\n');
await import('./server.js');
const base = 'http://localhost:' + (process.env.PORT || 3000);
for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
const tk = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'presidente@municipio.gob.mx', password: 'Demo12345' }) })).json()).token;
const cat = await (await fetch(base + '/api/procedures/plantillas', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: '{}' })).json();
console.log('Catálogo cargado: ' + (cat.creadas + cat.actualizadas) + ' trámites y servicios disponibles\n');
const { Infraccion, Ajuste } = await import('./models.js');
await fetch(base + '/api/infracciones/plantillas', { method: 'POST', headers: { Authorization: 'Bearer ' + tk } });
await Ajuste.create({ clave: 'uma', valor: 100 });
let kk = 0; for (const inf of await Infraccion.find().sort('reglamento descripcion')) { inf.umaMin = [5, 8, 10, 15, 20][kk++ % 5]; inf.umaMax = inf.umaMin * 3; inf.articulo = String(10 + kk); await inf.save(); }
const ta = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'agente@demo.mx', password: 'Demo12345' }) })).json()).token;
const pick = n => Infraccion.findOne({ descripcion: n });
for (const [n, b] of [['Estacionarse en lugar prohibido', { sujeto: 'vehiculo', identificador: 'ABC123', infractor: 'Conductor de ejemplo', lugar: 'Calle Principal, esquina Calle 2' }], ['Operar sin licencia de funcionamiento', { sujeto: 'establecimiento', infractor: 'Abarrotes (ejemplo)', identificador: 'LIC-0045', lugar: 'Calle 5 número 12', medida: 'Clausura temporal', acta: 'ACT-001' }], ['Tirar basura en la vía pública', { sujeto: 'persona', infractor: 'Persona de ejemplo', lugar: 'Camino rural', umas: 6 }], ['Construir sin licencia', { sujeto: 'predio', identificador: 'CAT778899', infractor: 'Propietario del predio', lugar: 'Colonia Norte', medida: 'Suspensión de obra' }], ['Música o ruido excesivo', { sujeto: 'establecimiento', infractor: 'Salón de eventos (ejemplo)', identificador: 'LIC-0102', lugar: 'Carretera principal km 2' }], ['Estacionarse en lugar prohibido', { sujeto: 'vehiculo', identificador: 'ABC123', infractor: 'Conductor de ejemplo', lugar: 'Parque central' }]]) await fetch(base + '/api/multas', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ta }, body: JSON.stringify({ ...b, infraccion: (await pick(n))._id }) });
console.log('Multas de ejemplo registradas. Consulta como ciudadano: placa ABC123 o licencia LIC-0045 (valor de la UMA de la demo: $100, dato ficticio).\n');

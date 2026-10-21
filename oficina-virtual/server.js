import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { User, Department, Category, Procedure, Case, Counter, Notification, Message, Audit, Payment, Aviso, Obra, Sesion, Cita, Inhabil, Cuenta, Propuesta, Proyecto, Ronda, Activo } from './models.js';

const SECRET = process.env.JWT_SECRET || 'cambia-esto';
const app = express(), server = http.createServer(app), io = new Server(server);
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
app.get('/health', (q, r) => r.send('ok'));

const STAFF = ['admin', 'presidente', 'director', 'coordinador', 'encargado'];
const TOP = ['admin', 'presidente'];
const FINAL = ['Resuelto', 'Cerrado', 'Entregado', 'Rechazado', 'Cancelado'];
const ESTATUS = {
  reporte: ['Sin clasificar', 'Recibido', 'Asignado', 'En proceso', 'Resuelto', 'Cerrado', 'Rechazado'],
  tramite: ['Recibido', 'En revisión', 'Prevención', 'En proceso', 'Pago pendiente', 'Pago en revisión', 'Pagado', 'Resuelto', 'Entregado', 'Rechazado', 'Cancelado']
};
const CREA = { admin: ['presidente', 'director', 'coordinador', 'encargado', 'caja'], presidente: ['director', 'caja'], director: ['coordinador', 'encargado'], coordinador: ['encargado'] };

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(e => { console.error(e); s.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' }); });
const sign = u => jwt.sign({ id: u._id }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u._id, nombre: u.nombre, email: u.email, role: u.role, department: u.department });
const audit = (u, accion, detalle) => Audit.create({ user: u._id, accion, detalle }).catch(() => {});
const auth = async (q, s, n) => {
  try { const { id } = jwt.verify((q.headers.authorization || '').slice(7), SECRET); q.user = await User.findById(id); if (!q.user || !q.user.activo) throw 0; n(); }
  catch { s.status(401).json({ error: 'No autorizado' }); }
};
const only = (...r) => (q, s, n) => r.includes(q.user.role) ? n() : s.status(403).json({ error: 'Sin permiso' });
const mail = async (id, texto) => {
  if (!process.env.RESEND_API_KEY) return;
  const u = await User.findById(id).select('email role sinCorreos'); if (u?.role !== 'ciudadano' || u.sinCorreos || u.email.endsWith('@sin-correo.local')) return;
  fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM || 'onboarding@resend.dev', to: u.email, subject: 'Aviso de tu ayuntamiento', text: texto }) }).catch(() => {});
};
const claude = async (system, content, max = 400) => {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content }] }) });
  return (await r.json()).content?.[0]?.text;
};
// Clasifica un reporte "Otro": con IA si hay ANTHROPIC_API_KEY; si no, por palabras clave.
async function clasificar(texto = '') {
  const cats = await Category.find(); if (!cats.length || !texto) return null;
  if (process.env.ANTHROPIC_API_KEY) try {
    const n = parseInt(await claude('Clasificas reportes ciudadanos. Responde solo con un número.', `${cats.map((c, i) => `${i + 1}. ${c.nombre}`).join('\n')}\nReporte: ${texto.slice(0, 500)}\nNúmero de la categoría (0 si ninguna aplica):`, 10));
    if (n > 0 && cats[n - 1]) return cats[n - 1];
  } catch {}
  const w = texto.toLowerCase().split(/\W+/).filter(x => x.length > 3);
  const best = cats.map(c => ({ c, n: w.filter(x => (c.nombre + ' ' + c.subcategorias.join(' ')).toLowerCase().includes(x)).length })).sort((a, b) => b.n - a.n)[0];
  return best?.n ? best.c : null;
}
async function registrarPago(c, metodo, ref) {
  if (c.estatus === 'Pagado' || await Payment.exists({ referencia: ref })) return;
  const n = await Counter.findByIdAndUpdate('pago', { $inc: { n: 1 } }, { upsert: true, new: true });
  await Payment.create({ folio: `PAG-${new Date().getFullYear()}-${String(n.n).padStart(6, '0')}`, caso: c._id, casoFolio: c.folio, concepto: c.titulo, ciudadano: c.ciudadano, department: c.department, monto: c.costo, metodo, referencia: ref });
  c.estatus = 'Pagado'; c.historial.push({ estatus: 'Pagado', nota: `Pago confirmado (${metodo})` }); await c.save();
  if (c.cuenta) { await Cuenta.updateOne({ _id: c.cuenta }, { adeudo: 0, ultimoPago: new Date() }); c.estatus = 'Resuelto'; c.cerradoEn = new Date(); await c.save(); }
  await notify([c.asignadoA, c.coordinador, c.ciudadano], `${c.folio}: pago recibido por $${c.costo}`, c._id);
}
const HORAS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'];
const notify = async (ids, texto, caso) => {
  for (const id of new Set(ids.filter(Boolean).map(String))) { const n = await Notification.create({ user: id, texto, caso }); io.to('u:' + id).emit('notif', n); mail(id, texto); }
};

// Quién ve qué: cada nivel ve lo suyo y hacia arriba se agrega.
const scope = u => ({
  admin: {}, presidente: {},
  director: { department: u.department },
  coordinador: { $or: [{ coordinador: u._id }, { asignadoA: u._id }] },
  encargado: { asignadoA: u._id },
  ciudadano: { ciudadano: u._id },
  caja: { _id: null }
})[u.role];

// Enrutamiento automático: encargado con menos carga -> su coordinador -> director del departamento.
async function assign(deptId) {
  const dept = await Department.findById(deptId); if (!dept) return {};
  const pick = async role => {
    const l = await Promise.all((await User.find({ department: deptId, role, activo: true })).map(async u => ({ u, n: await Case.countDocuments({ asignadoA: u._id, estatus: { $nin: FINAL } }) })));
    return l.sort((a, b) => a.n - b.n)[0]?.u;
  };
  const enc = await pick('encargado'); let coord = null;
  if (enc?.parent) { const p = await User.findById(enc.parent); if (p?.role === 'coordinador') coord = p; }
  coord = coord || await pick('coordinador');
  return { asignadoA: (enc || coord)?._id || dept.director, coordinador: coord?._id, director: dept.director };
}

async function nextFolio(tipo) {
  const y = new Date().getFullYear();
  const c = await Counter.findByIdAndUpdate(`${tipo}-${y}`, { $inc: { n: 1 } }, { upsert: true, new: true });
  return `${tipo === 'reporte' ? 'REP' : 'TRA'}-${y}-${String(c.n).padStart(6, '0')}`;
}

async function createCase(user, tipo, b) {
  let dept, cat, proc, titulo, sla, datosC;
  if (tipo === 'reporte') {
    cat = b.category ? await Category.findById(b.category) : await clasificar(b.descripcion); dept = cat?.department;
    titulo = cat ? cat.nombre + (b.subcategoria ? ' · ' + b.subcategoria : '') : 'Otro';
    sla = new Date(Date.now() + (cat?.slaHoras || 48) * 36e5);
  } else {
    proc = await Procedure.findById(b.procedure); if (!proc?.activo) throw bad('Trámite no disponible');
    dept = proc.department; titulo = proc.nombre; sla = await venceTramite(proc.slaDias);
    const falta = (proc.campos || []).find(c => c.obligatorio && !String(b.datos?.[c.id] ?? '').trim()); if (falta) throw bad('Falta completar: ' + falta.label);
    datosC = Object.fromEntries((proc.campos || []).map(c => [c.label, String(b.datos?.[c.id] ?? '').slice(0, 300)]));
  }
  const a = dept ? await assign(dept) : {};
  const estatus = dept ? (tipo === 'reporte' ? 'Asignado' : 'Recibido') : 'Sin clasificar';
  const c = await Case.create({
    folio: await nextFolio(tipo), tipo, ciudadano: user._id, department: dept, category: cat?._id, subcategoria: b.subcategoria, procedure: proc?._id,
    titulo, descripcion: b.descripcion, datos: datosC ?? b.datos, ubicacion: b.ubicacion, costo: proc?.costo.monto,
    fotos: (b.fotos || []).filter(f => typeof f === 'string' && f.startsWith('data:image/')).slice(0, 3),
    documentos: (b.documentos || []).filter(d => typeof d.data === 'string' && /^data:(image|application\/pdf)/.test(d.data)).slice(0, 4).map(d => ({ nombre: String(d.nombre || 'documento').slice(0, 80), data: d.data })),
    estatus, ...a, slaVence: sla, historial: [{ estatus, por: user._id, nota: 'Creado' }]
  });
  await notify([a.asignadoA, a.coordinador, a.director], `Nuevo ${tipo}: ${c.folio} · ${titulo}`, c._id);
  if (!dept) await notify((await User.find({ role: 'presidente' })).map(p => p._id), `Reporte sin clasificar: ${c.folio}`, c._id);
  return c;
}
const getCase = async (q, id) => { const c = await Case.findOne({ $and: [{ _id: id }, scope(q.user)] }); if (!c) throw bad('Folio no encontrado', 404); return c; };
const canDept = (u, d) => TOP.includes(u.role) || String(u.department) === String(d);

const api = express.Router(); app.use('/api', api);
api.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));

// --- Autenticación
api.post('/auth/register', wrap(async (q, s) => {
  const { nombre, email, password, telefono, acepto } = q.body;
  if (!acepto) throw bad('Debes aceptar el aviso de privacidad');
  if (!nombre || !email || !password || password.length < 8) throw bad('Datos incompletos (contraseña mínimo 8)');
  if (await User.findOne({ email: email.toLowerCase() })) throw bad('Correo ya registrado', 409);
  const u = await User.create({ nombre, email, telefono, password: await bcrypt.hash(password, 10), role: 'ciudadano', consentimiento: new Date() });
  const t = crypto.randomBytes(24).toString('hex'); u.verifHash = hash(t); await u.save();
  sendMail(u.email, 'Confirma tu correo', `Confirma tu correo aquí: ${base(q)}/?verificar_correo=${t}`);
  s.json({ token: sign(u), user: pub(u) });
}));
api.post('/auth/login', wrap(async (q, s) => {
  const u = await User.findOne({ email: String(q.body.email || '').toLowerCase() });
  if (!u || !u.activo || !(await bcrypt.compare(q.body.password || '', u.password))) throw bad('Credenciales incorrectas', 401);
  s.json({ token: sign(u), user: pub(u) });
}));
api.get('/auth/me', auth, (q, s) => s.json(pub(q.user)));

// --- Estructura: departamentos, personal, categorías
api.get('/departments', auth, only(...STAFF), wrap(async (q, s) => s.json(await Department.find().populate('director', 'nombre'))));
api.post('/departments', auth, only(...TOP), wrap(async (q, s) => {
  if (!q.body.nombre) throw bad('Falta nombre'); const d = await Department.create({ nombre: q.body.nombre }); audit(q.user, 'crear_depto', d._id); s.json(d);
}));
api.post('/users', auth, only(...Object.keys(CREA)), wrap(async (q, s) => {
  const { nombre, email, password, role, department } = q.body, me = q.user;
  if (!CREA[me.role].includes(role)) throw bad('No puedes crear ese rol', 403);
  if (!nombre || !email || !password || password.length < 8) throw bad('Datos incompletos (contraseña mínimo 8)');
  if (await User.findOne({ email: email.toLowerCase() })) throw bad('Correo ya registrado', 409);
  const dept = TOP.includes(me.role) ? department : me.department;
  if (!['presidente', 'caja'].includes(role) && !dept) throw bad('Falta departamento');
  const u = await User.create({ nombre, email, password: await bcrypt.hash(password, 10), role, department: ['presidente', 'caja'].includes(role) ? undefined : dept, parent: me._id });
  if (role === 'director') await Department.findByIdAndUpdate(dept, { director: u._id });
  audit(me, 'crear_usuario', { id: u._id, role }); s.json(pub(u));
}));
api.get('/users', auth, only(...STAFF), wrap(async (q, s) => {
  const f = { role: { $ne: 'ciudadano' } }; if (!TOP.includes(q.user.role)) f.department = q.user.department;
  s.json(await User.find(f).select('-password').populate('department', 'nombre'));
}));
api.patch('/users/:id/activo', auth, only(...Object.keys(CREA)), wrap(async (q, s) => {
  const u = await User.findById(q.params.id);
  if (!u || !CREA[q.user.role].includes(u.role) || (!TOP.includes(q.user.role) && String(u.department) !== String(q.user.department))) throw bad('Sin permiso', 403);
  u.activo = !u.activo; await u.save(); audit(q.user, 'activo_usuario', { id: u._id, activo: u.activo }); s.json({ activo: u.activo });
}));
api.post('/categories', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const { nombre, subcategorias, department, slaHoras } = q.body; if (!nombre) throw bad('Falta nombre');
  s.json(await Category.create({ nombre, subcategorias: subcategorias || [], department: q.user.role === 'director' ? q.user.department : department, slaHoras: slaHoras || 48 }));
}));
api.get('/catalog', wrap(async (q, s) => s.json({ categorias: await Category.find(), tramites: await Procedure.find({ activo: true }).populate('department', 'nombre') })));

// --- Trámites (catálogo por departamento; el cambio de precio lo aprueba el director)
api.get('/procedures', auth, only(...STAFF), wrap(async (q, s) => s.json(await Procedure.find(TOP.includes(q.user.role) ? {} : { department: q.user.department }).populate('department', 'nombre'))));
api.post('/procedures', auth, only(...STAFF), wrap(async (q, s) => {
  const { nombre, descripcion, requisitos, costo, slaDias, department, fundamento } = q.body, me = q.user; if (!nombre) throw bad('Falta nombre');
  const m = +costo || 0, aprueba = ['admin', 'presidente', 'director'].includes(me.role);
  const p = await Procedure.create({
    nombre, descripcion, department: TOP.includes(me.role) ? department : me.department,
    requisitos: (requisitos || []).map(n => ({ nombre: n })), campos: parseCampos(q.body.campos), etapas: lines(q.body.etapas), slaDias: slaDias || 5,
    costo: { tipo: aprueba && m > 0 ? 'fijo' : 'gratis', monto: aprueba ? m : 0, fundamento: String(fundamento || '').slice(0, 200) },
    costoPendiente: !aprueba && m ? { monto: m, por: me._id } : undefined,
    historialCostos: aprueba ? [{ monto: m, por: me._id, fecha: new Date() }] : []
  });
  audit(me, 'crear_tramite', p._id); s.json(p);
}));
api.put('/procedures/:id', auth, only(...STAFF), wrap(async (q, s) => {
  const p = await Procedure.findById(q.params.id); if (!p || !canDept(q.user, p.department)) throw bad('No encontrado', 404);
  const b = q.body; ['nombre', 'descripcion', 'slaDias', 'activo'].forEach(k => b[k] !== undefined && (p[k] = b[k]));
  if (b.requisitos) p.requisitos = b.requisitos.map(n => ({ nombre: n }));
  if (b.campos !== undefined) p.campos = parseCampos(b.campos); if (b.etapas !== undefined) p.etapas = lines(b.etapas);
  if (b.costo !== undefined) {
    const m = +b.costo;
    if (['admin', 'presidente', 'director'].includes(q.user.role)) { p.costo.monto = m; p.costo.tipo = m > 0 ? 'fijo' : 'gratis'; p.costoPendiente = undefined; p.historialCostos.push({ monto: m, por: q.user._id, fecha: new Date() }); }
    else p.costoPendiente = { monto: m, por: q.user._id };
  }
  if (b.fundamento !== undefined && ['admin', 'presidente', 'director'].includes(q.user.role)) p.costo.fundamento = String(b.fundamento).slice(0, 200);
  await p.save(); audit(q.user, 'editar_tramite', { id: p._id, costo: b.costo }); s.json(p);
}));
api.post('/procedures/:id/costo', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const p = await Procedure.findById(q.params.id); if (!p?.costoPendiente || !canDept(q.user, p.department)) throw bad('Sin cambio pendiente', 404);
  if (q.body.aprobar) { const m = p.costoPendiente.monto; p.costo.monto = m; p.costo.tipo = m > 0 ? 'fijo' : 'gratis'; p.historialCostos.push({ monto: m, por: q.user._id, fecha: new Date() }); }
  p.costoPendiente = undefined; await p.save(); audit(q.user, 'resolver_costo', { id: p._id, aprobar: !!q.body.aprobar }); s.json(p);
}));

// --- Casos (reportes y trámites)
api.post('/cases', auth, only('ciudadano'), wrap(async (q, s) => {
  const { tipo } = q.body; if (!['reporte', 'tramite'].includes(tipo)) throw bad('Tipo inválido');
  if (process.env.RESEND_API_KEY && !q.user.correoVerificado) throw bad('Confirma tu correo: te enviamos un enlace al registrarte');
  if (tipo === 'reporte' && !q.body.descripcion) throw bad('Describe el problema');
  s.json(await createCase(q.user, tipo, q.body));
}));
api.get('/cases', auth, wrap(async (q, s) => {
  const { estatus, tipo } = q.query;
  s.json(await Case.find({ $and: [scope(q.user), ...(estatus ? [{ estatus }] : []), ...(tipo ? [{ tipo }] : [])] })
    .select('-hilo -fotos -historial -documentos -transferencia -evidencias').sort('-createdAt').limit(200).populate('asignadoA', 'nombre').populate('department', 'nombre'));
}));
api.get('/cases/:id', auth, wrap(async (q, s) => {
  const c = await (await getCase(q, q.params.id)).populate([{ path: 'asignadoA', select: 'nombre' }, { path: 'department', select: 'nombre' }, { path: 'ciudadano', select: 'nombre email telefono' }, { path: 'hilo.autor', select: 'nombre' }]);
  const o = c.toObject(); o.etapas = c.procedure ? (await Procedure.findById(c.procedure).select('etapas'))?.etapas || [] : []; if (q.user.role === 'ciudadano') o.hilo = o.hilo.filter(h => !h.interno); s.json(o);
}));
api.post('/cases/:id/estatus', auth, only(...STAFF), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), { estatus, nota } = q.body;
  if (!ESTATUS[c.tipo].includes(estatus) || estatus === 'Sin clasificar') throw bad('Estatus inválido');
  c.estatus = estatus; c.historial.push({ estatus, por: q.user._id, nota }); c.cerradoEn = FINAL.includes(estatus) ? new Date() : undefined;
  await c.save(); await notify([c.ciudadano], `${c.folio}: ahora está "${estatus}"`, c._id); audit(q.user, 'estatus', { folio: c.folio, estatus }); s.json({ ok: 1 });
}));
api.post('/cases/:id/hilo', auth, wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), cit = q.user.role === 'ciudadano', interno = !cit && !!q.body.interno;
  if (!q.body.texto) throw bad('Escribe un mensaje');
  c.hilo.push({ autor: q.user._id, rol: q.user.role, texto: q.body.texto, interno }); await c.save();
  await notify(interno ? [c.coordinador, c.asignadoA, c.director].filter(x => String(x) !== String(q.user._id)) : cit ? [c.asignadoA, c.coordinador] : [c.ciudadano], `${c.folio}: nuevo mensaje`, c._id);
  s.json({ ok: 1 });
}));
api.post('/cases/:id/asignar', auth, only('admin', 'presidente', 'director', 'coordinador'), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), u = await User.findById(q.body.userId);
  if (!u || !STAFF.includes(u.role) || String(u.department) !== String(c.department)) throw bad('Usuario no válido para este departamento');
  c.asignadoA = u._id;
  if (u.role === 'coordinador') c.coordinador = u._id; else if (u.parent) { const p = await User.findById(u.parent); if (p?.role === 'coordinador') c.coordinador = p._id; }
  c.historial.push({ estatus: c.estatus, por: q.user._id, nota: 'Reasignado a ' + u.nombre }); await c.save();
  await notify([u._id], `Se te asignó ${c.folio}`, c._id); s.json({ ok: 1 });
}));
api.post('/cases/:id/turnar', auth, only('admin', 'presidente', 'director', 'coordinador'), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id); if (!(await Department.exists({ _id: q.body.department }))) throw bad('Departamento inválido');
  const a = await assign(q.body.department); Object.assign(c, { department: q.body.department, ...a });
  if (c.estatus === 'Sin clasificar') c.estatus = c.tipo === 'reporte' ? 'Asignado' : 'Recibido';
  c.historial.push({ estatus: c.estatus, por: q.user._id, nota: 'Turnado a otro departamento' }); await c.save();
  await notify([a.asignadoA, a.coordinador, a.director, c.ciudadano], `${c.folio} turnado a un nuevo departamento`, c._id); s.json({ ok: 1 });
}));
api.post('/cases/:id/calificar', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id); if (!FINAL.includes(c.estatus)) throw bad('Aún no se resuelve');
  c.calificacion = Math.min(5, Math.max(1, +q.body.calificacion || 0)); await c.save(); s.json({ ok: 1 });
}));
api.post('/cases/:id/pagar', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id); if (c.estatus !== 'Pago pendiente' || !c.costo) throw bad('Este folio no tiene un pago pendiente');
  const metodo = ['tarjeta', 'spei', 'efectivo'].includes(q.body.metodo) ? q.body.metodo : 'tarjeta';
  const n = await Counter.findByIdAndUpdate('pago', { $inc: { n: 1 } }, { upsert: true, new: true });
  const p = await Payment.create({ folio: `PAG-${new Date().getFullYear()}-${String(n.n).padStart(6, '0')}`, caso: c._id, casoFolio: c.folio, concepto: c.titulo, ciudadano: c.ciudadano, department: c.department, monto: c.costo, metodo });
  c.estatus = 'Pagado'; c.historial.push({ estatus: 'Pagado', por: q.user._id, nota: `Pago ${p.folio} (${metodo}, simulado)` }); await c.save();
  await notify([c.asignadoA, c.coordinador], `${c.folio}: el ciudadano pagó $${p.monto}`, c._id); audit(q.user, 'pago', { folio: p.folio }); s.json(p);
}));
api.get('/pagos', auth, only('admin', 'presidente', 'director', 'caja'), wrap(async (q, s) => {
  s.json(await Payment.find(q.user.role === 'director' ? { department: q.user.department } : {}).sort('-createdAt').limit(200).populate('ciudadano', 'nombre').populate('department', 'nombre'));
}));
api.use('/ia', rateLimit({ windowMs: 60 * 1000, max: 10 }));
api.post('/ia/preguntar', auth, wrap(async (q, s) => {
  const pregunta = String(q.body.pregunta || '').slice(0, 400); if (!pregunta) throw bad('Escribe tu pregunta');
  const tr = await Procedure.find({ activo: true }).populate('department', 'nombre');
  const fila = t => `${t.nombre} (${t.department?.nombre}): costo $${t.costo.monto}, respuesta en ${t.slaDias} días. Requisitos: ${t.requisitos.map(r => r.nombre).join(', ')}.`;
  if (process.env.ANTHROPIC_API_KEY) try { return s.json({ respuesta: await claude('Eres el asistente virtual de un ayuntamiento de México. Responde breve, claro y en español usando SOLO este catálogo. Si no está, dilo y sugiere acudir a ventanilla.\n' + tr.map(fila).join('\n'), pregunta) }); } catch {}
  const w = pregunta.toLowerCase().split(/\W+/).filter(x => x.length > 3), hit = tr.filter(t => w.some(x => t.nombre.toLowerCase().includes(x)));
  s.json({ respuesta: hit.length ? hit.map(fila).join('\n') : 'No encontré ese trámite. Revisa el catálogo o acude a ventanilla.' });
}));
api.post('/cases/:id/pagar-mp', auth, only('ciudadano'), wrap(async (q, s) => {
  if (!process.env.MP_ACCESS_TOKEN) throw bad('Mercado Pago no está configurado', 501);
  const c = await getCase(q, q.params.id); if (c.estatus !== 'Pago pendiente' || !c.costo) throw bad('Este folio no tiene un pago pendiente');
  const base = process.env.PUBLIC_URL || `${q.protocol}://${q.get('host')}`;
  const r = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ title: `${c.titulo} (${c.folio})`, quantity: 1, currency_id: 'MXN', unit_price: c.costo }], external_reference: String(c._id), notification_url: base + '/api/pagos/webhook', back_urls: { success: base, failure: base, pending: base }, auto_return: 'approved' }) });
  const j = await r.json(); if (!j.init_point) throw bad('No se pudo crear el pago'); s.json({ url: j.init_point });
}));
api.post('/pagos/webhook', wrap(async (q, s) => {
  const id = q.body?.data?.id || q.query['data.id']; s.sendStatus(200); if (!id || !process.env.MP_ACCESS_TOKEN) return;
  const p = await (await fetch('https://api.mercadopago.com/v1/payments/' + id, { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } })).json();
  const c = p.status === 'approved' && p.external_reference ? await Case.findById(p.external_reference) : null;
  if (c && p.transaction_amount >= c.costo) await registrarPago(c, 'mercadopago', String(id));
}));
api.get('/transparencia', wrap(async (q, s) => s.json({
  obras: await Obra.find().sort('-createdAt').populate('department', 'nombre'),
  sesiones: await Sesion.find().sort('-fecha').limit(20),
  directorio: await User.find({ role: { $in: ['presidente', 'director'] }, activo: true }).select('nombre role department').populate('department', 'nombre')
})));
api.post('/obras', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const b = q.body; if (!b.nombre) throw bad('Falta el nombre');
  s.json(await Obra.create({ nombre: b.nombre, descripcion: b.descripcion, presupuesto: +b.presupuesto || 0, avance: Math.min(100, +b.avance || 0), zona: b.zona, department: q.user.role === 'director' ? q.user.department : b.department }));
}));
api.patch('/obras/:id', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const o = await Obra.findById(q.params.id); if (!o || !canDept(q.user, o.department)) throw bad('No encontrada', 404);
  o.avance = Math.min(100, Math.max(0, +q.body.avance || 0)); o.estatus = o.avance >= 100 ? 'Concluida' : 'En proceso'; await o.save(); s.json(o);
}));
api.post('/sesiones', auth, only('admin', 'presidente'), wrap(async (q, s) => {
  if (!q.body.titulo) throw bad('Falta el tema'); const { titulo, fecha, tipo, resumen, videoUrl } = q.body;
  s.json(await Sesion.create({ titulo, fecha: fecha ? new Date(fecha) : new Date(), tipo, resumen, videoUrl }));
}));
api.get('/citas/disponibles', wrap(async (q, s) => {
  const t = (await Cita.find({ department: q.query.department, fecha: q.query.fecha, estatus: 'Programada' })).map(c => c.hora);
  s.json([0, 6].includes(new Date(q.query.fecha + 'T12:00:00').getDay()) || await Inhabil.exists({ fecha: q.query.fecha }) ? [] : HORAS.filter(h => !t.includes(h)));
}));
api.post('/citas', auth, only('ciudadano'), wrap(async (q, s) => {
  const { department, fecha, hora, tramite } = q.body, d = new Date(fecha + 'T12:00:00');
  if (!HORAS.includes(hora) || isNaN(d) || [0, 6].includes(d.getDay()) || await Inhabil.exists({ fecha }) || d < new Date(Date.now() - 864e5) || !(await Department.exists({ _id: department }))) throw bad('Fecha u horario no válido');
  if (await Cita.exists({ department, fecha, hora, estatus: 'Programada' })) throw bad('Ese horario ya fue tomado', 409);
  const c = await Cita.create({ ciudadano: q.user._id, department, fecha, hora, tramite: String(tramite || 'Consulta').slice(0, 100) });
  await notify([(await Department.findById(department)).director], `Nueva cita ${fecha} ${hora}: ${c.tramite}`); s.json(c);
}));
api.get('/citas', auth, wrap(async (q, s) => {
  const f = q.user.role === 'ciudadano' ? { ciudadano: q.user._id } : TOP.includes(q.user.role) ? {} : { department: q.user.department };
  s.json(await Cita.find(f).sort('fecha hora').limit(200).populate('department', 'nombre').populate('ciudadano', 'nombre'));
}));
api.post('/citas/:id/estatus', auth, only(...STAFF), wrap(async (q, s) => {
  const c = await Cita.findById(q.params.id); if (!c || !canDept(q.user, c.department)) throw bad('No encontrada', 404);
  if (!['Atendida', 'No asistió', 'Cancelada'].includes(q.body.estatus)) throw bad('Estatus inválido'); c.estatus = q.body.estatus; await c.save(); s.json({ ok: 1 });
}));
api.get('/export/casos.csv', auth, only(...STAFF), wrap(async (q, s) => {
  const l = await Case.find(scope(q.user)).sort('-createdAt').populate('department', 'nombre').populate('asignadoA', 'nombre'), e = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  s.type('text/csv').send('\ufeff' + ['Folio,Tipo,Asunto,Estatus,Departamento,Asignado,Creado,Costo', ...l.map(c => [c.folio, c.tipo, c.titulo, c.estatus, c.department?.nombre, c.asignadoA?.nombre, c.createdAt.toISOString(), c.costo].map(e).join(','))].join('\n'));
}));
api.get('/config', (q, s) => s.json({ nombre: process.env.MUNICIPIO || 'H. Ayuntamiento Constitucional', lema: process.env.LEMA || 'Un gobierno más cerca de ti', color: process.env.COLOR || '', mp: !!process.env.MP_ACCESS_TOKEN, clabe: process.env.CLABE || '', banco: process.env.BANCO || '', titular: process.env.TITULAR || '' }));
api.get('/avisos', wrap(async (q, s) => s.json(await Aviso.find({ activo: true }).sort('-createdAt').limit(8))));
api.post('/avisos', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const { titulo, texto, tipo } = q.body; if (!titulo || !texto) throw bad('Faltan título o texto');
  const a = await Aviso.create({ titulo, texto, tipo: ['aviso', 'obra', 'alerta'].includes(tipo) ? tipo : 'aviso', autor: q.user._id, zona: q.body.zona || 'Todo el municipio' }); if (a.tipo === 'alerta') io.emit('alerta', a); audit(q.user, 'aviso', a._id); s.json(a);
}));
const CAJA = ['admin', 'presidente', 'caja'];
api.post('/cases/:id/transferencia', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id); if (c.estatus !== 'Pago pendiente' || !c.costo) throw bad('Este folio no tiene un pago pendiente');
  const { fecha, comprobante } = q.body, k = String(q.body.claveRastreo || '').trim().toUpperCase();
  if (k.length < 6 || !fecha || !/^data:(image|application\/pdf)/.test(comprobante || '')) throw bad('Captura la clave de rastreo, la fecha y adjunta el comprobante');
  if (await Case.exists({ _id: { $ne: c._id }, 'transferencia.claveRastreo': k }) || await Payment.exists({ referencia: k })) throw bad('Esa clave de rastreo ya fue usada en otro folio', 409);
  c.transferencia = { claveRastreo: k, fecha, comprobante, enviadoEn: new Date() }; c.estatus = 'Pago en revisión';
  c.historial.push({ estatus: c.estatus, por: q.user._id, nota: 'Comprobante enviado' }); await c.save();
  await notify((await User.find({ role: 'caja', activo: true })).map(u => u._id), `Pago por validar: ${c.folio} · $${c.costo}`, c._id); s.json({ ok: 1 });
}));
api.get('/pagos/pendientes', auth, only(...CAJA), wrap(async (q, s) => s.json(await Case.find({ estatus: 'Pago en revisión' }).select('folio titulo costo transferencia asignadoA createdAt').populate('ciudadano', 'nombre').sort('createdAt'))));
api.post('/pagos/:id/validar', auth, only(...CAJA), wrap(async (q, s) => {
  const c = await Case.findById(q.params.id); if (!c || c.estatus !== 'Pago en revisión') throw bad('No hay un pago por validar en este folio', 404);
  if (String(c.asignadoA) === String(q.user._id)) throw bad('No puedes aprobar el pago de un folio que tú atiendes', 403);
  c.transferencia.revisadoPor = q.user._id;
  if (q.body.aprobar) {
    if (+q.body.monto !== c.costo) throw bad('El monto que aparece en el banco debe coincidir exactamente con $' + c.costo);
    await c.save(); await registrarPago(c, 'spei', c.transferencia.claveRastreo);
  } else {
    if (!q.body.motivo) throw bad('Indica el motivo del rechazo');
    c.transferencia.motivo = q.body.motivo; c.estatus = 'Pago pendiente'; c.historial.push({ estatus: c.estatus, por: q.user._id, nota: 'Comprobante rechazado: ' + q.body.motivo }); await c.save();
    await notify([c.ciudadano], `${c.folio}: tu comprobante fue rechazado (${q.body.motivo}). Puedes subirlo de nuevo.`, c._id);
  }
  audit(q.user, 'validar_pago', { folio: c.folio, aprobar: !!q.body.aprobar }); s.json({ ok: 1 });
}));
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const base = q => process.env.PUBLIC_URL || `${q.protocol}://${q.get('host')}`;
const sendMail = async (to, subject, text) => {
  if (!process.env.RESEND_API_KEY) return console.log(`\n[correo simulado] Para: ${to}\n${subject}\n${text}\n`);
  fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM || 'onboarding@resend.dev', to, subject, text }) }).catch(() => {});
};
// Plazo en días hábiles: excluye sábados, domingos y los días inhábiles registrados.
async function venceTramite(dias) {
  const libres = new Set((await Inhabil.find()).map(i => i.fecha)); let d = new Date(), n = 0;
  while (n < dias) { d = new Date(d.getTime() + 864e5); if (![0, 6].includes(d.getDay()) && !libres.has(d.toISOString().slice(0, 10))) n++; }
  return d;
}
async function recordar() {
  const m = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  for (const c of await Cita.find({ estatus: 'Programada', fecha: m, recordada: { $ne: true } })) { c.recordada = true; await c.save(); await notify([c.ciudadano], `Recordatorio: mañana ${c.fecha} a las ${c.hora} tienes una cita (${c.tramite}).`); }
}
api.post('/auth/olvide', wrap(async (q, s) => {
  const u = await User.findOne({ email: String(q.body.email || '').toLowerCase() });
  if (u?.activo) { const t = crypto.randomBytes(24).toString('hex'); u.resetHash = hash(t); u.resetExp = new Date(Date.now() + 36e5); await u.save(); sendMail(u.email, 'Recupera tu contraseña', `Crea una nueva contraseña (el enlace vence en 1 hora): ${base(q)}/?reset=${t}`); }
  s.json({ ok: 1 });
}));
api.post('/auth/reset', wrap(async (q, s) => {
  const { token, password } = q.body; if (!token || !password || password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
  const u = await User.findOne({ resetHash: hash(String(token)), resetExp: { $gt: new Date() } }); if (!u) throw bad('El enlace no es válido o ya venció');
  u.password = await bcrypt.hash(password, 10); u.resetHash = undefined; u.resetExp = undefined; await u.save(); s.json({ ok: 1 });
}));
api.post('/auth/verificar-correo', wrap(async (q, s) => {
  const u = await User.findOne({ verifHash: hash(String(q.body.token || '')) }); if (!u) throw bad('El enlace no es válido');
  u.correoVerificado = true; u.verifHash = undefined; await u.save(); s.json({ ok: 1 });
}));
api.post('/cases/ventanilla', auth, only(...STAFF), wrap(async (q, s) => {
  const { nombre, telefono, email, tipo } = q.body; if (!nombre || !['reporte', 'tramite'].includes(tipo)) throw bad('Captura el nombre del ciudadano y el tipo de solicitud');
  if (tipo === 'reporte' && !q.body.descripcion) throw bad('Describe el problema');
  const correo = String(email || '').toLowerCase().trim() || `ventanilla-${crypto.randomBytes(5).toString('hex')}@sin-correo.local`;
  const u = await User.findOne({ email: correo }) || await User.create({ nombre, telefono, email: correo, password: await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 10), role: 'ciudadano', consentimiento: new Date() });
  const c = await createCase(u, tipo, q.body); audit(q.user, 'ventanilla', { folio: c.folio }); s.json({ folio: c.folio });
}));
api.get('/cases/:id/constancia', auth, wrap(async (q, s) => {
  const c = await (await getCase(q, q.params.id)).populate([{ path: 'ciudadano', select: 'nombre' }, { path: 'department', select: 'nombre' }]);
  if (c.tipo !== 'tramite' || !['Resuelto', 'Entregado'].includes(c.estatus)) throw bad('La constancia se emite cuando el trámite está resuelto');
  const url = `${base(q)}/?folio=${c.folio}`;
  s.json({ folio: c.folio, titulo: c.titulo, ciudadano: c.ciudadano?.nombre, departamento: c.department?.nombre, fecha: c.cerradoEn || c.updatedAt, costo: c.costo, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
}));
api.post('/citas/:id/cancelar', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await Cita.findOne({ _id: q.params.id, ciudadano: q.user._id, estatus: 'Programada' }); if (!c) throw bad('Cita no encontrada', 404);
  c.estatus = 'Cancelada'; await c.save(); s.json({ ok: 1 });
}));
api.post('/citas/:id/reprogramar', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await Cita.findOne({ _id: q.params.id, ciudadano: q.user._id, estatus: 'Programada' }); if (!c) throw bad('Cita no encontrada', 404);
  const { fecha, hora } = q.body, d = new Date(fecha + 'T12:00:00');
  if (!HORAS.includes(hora) || isNaN(d) || [0, 6].includes(d.getDay()) || await Inhabil.exists({ fecha }) || d < new Date(Date.now() - 864e5)) throw bad('Fecha u horario no válido');
  if (await Cita.exists({ _id: { $ne: c._id }, department: c.department, fecha, hora, estatus: 'Programada' })) throw bad('Ese horario ya fue tomado', 409);
  Object.assign(c, { fecha, hora, recordada: false }); await c.save(); s.json({ ok: 1 });
}));
api.get('/inhabiles', auth, only(...STAFF), wrap(async (q, s) => s.json(await Inhabil.find().sort('fecha'))));
api.post('/inhabiles', auth, only(...TOP), wrap(async (q, s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.body.fecha || '')) throw bad('Fecha no válida');
  s.json(await Inhabil.findOneAndUpdate({ fecha: q.body.fecha }, { motivo: q.body.motivo }, { upsert: true, new: true }));
}));
api.delete('/inhabiles/:id', auth, only(...TOP), wrap(async (q, s) => { await Inhabil.findByIdAndDelete(q.params.id); s.json({ ok: 1 }); }));
// Derechos ARCO
api.get('/arco/acceso', auth, only('ciudadano'), wrap(async (q, s) => {
  const u = q.user;
  s.json({ datos: { nombre: u.nombre, email: u.email, telefono: u.telefono, registro: u.createdAt, consentimiento: u.consentimiento },
    folios: await Case.find({ ciudadano: u._id }).select('folio tipo titulo descripcion estatus costo createdAt historial hilo').lean(),
    pagos: await Payment.find({ ciudadano: u._id }).select('folio concepto monto metodo createdAt').lean(),
    citas: await Cita.find({ ciudadano: u._id }).select('fecha hora tramite estatus').lean() });
}));
api.post('/arco/rectificar', auth, only('ciudadano'), wrap(async (q, s) => {
  if (!q.body.nombre) throw bad('El nombre no puede quedar vacío');
  q.user.nombre = String(q.body.nombre).slice(0, 100); q.user.telefono = String(q.body.telefono || '').slice(0, 20); await q.user.save(); audit(q.user, 'arco_rectificar', {}); s.json(pub(q.user));
}));
api.post('/arco/oposicion', auth, only('ciudadano'), wrap(async (q, s) => { q.user.sinCorreos = !!q.body.sinCorreos; await q.user.save(); s.json({ sinCorreos: q.user.sinCorreos }); }));
api.post('/arco/cancelar', auth, only('ciudadano'), wrap(async (q, s) => {
  if (!(await bcrypt.compare(q.body.password || '', q.user.password))) throw bad('Contraseña incorrecta', 401);
  const u = q.user; Object.assign(u, { nombre: 'Usuario eliminado', telefono: '', email: `eliminado-${u._id}@invalid.local`, password: await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 10), activo: false, sinCorreos: true });
  await u.save(); audit(u, 'arco_cancelacion', {}); s.json({ ok: 1 });
}));
const lines = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
const parseCampos = v => lines(v).map((l, i) => { const [label, tipo = 'texto', op = ''] = l.split('|').map(x => x.trim()); return { id: 'c' + i, label, tipo: ['texto', 'numero', 'fecha', 'lista'].includes(tipo) ? tipo : 'texto', obligatorio: true, opciones: op ? op.split(',').map(x => x.trim()) : [] }; });
const PLANTILLAS = [
  { nombre: 'Constancia de residencia', descripcion: 'Acredita tu domicilio en el municipio.', costo: 80, slaDias: 3, requisitos: ['Identificación oficial', 'Comprobante de domicilio'], campos: 'Domicilio completo|texto\nAños viviendo en el municipio|numero', etapas: 'Revisión documental\nEmisión de constancia' },
  { nombre: 'Licencia de funcionamiento SARE (bajo riesgo)', descripcion: 'Apertura rápida de negocios de bajo riesgo.', costo: 0, slaDias: 2, requisitos: ['Identificación oficial', 'CURP', 'Comprobante de domicilio del negocio'], campos: 'Nombre del negocio|texto\nGiro o actividad|texto\nDirección del negocio|texto\nSuperficie en m²|numero', etapas: 'Revisión documental\nVerificación del giro\nEmisión de licencia' },
  { nombre: 'Licencia de construcción', descripcion: 'Permiso para construir, ampliar o remodelar.', costo: 0, slaDias: 15, requisitos: ['Escritura o título de propiedad', 'Planos firmados', 'Identificación oficial', 'Predial al corriente'], campos: 'Clave catastral|texto\nTipo de obra|lista|Construcción nueva,Ampliación,Remodelación\nMetros cuadrados|numero', etapas: 'Revisión documental\nInspección en sitio\nCálculo de derechos\nEmisión de licencia' },
  { nombre: 'Licencia para venta de alcohol', descripcion: 'Autorización para venta de bebidas alcohólicas.', costo: 0, slaDias: 20, requisitos: ['Identificación oficial', 'Licencia de funcionamiento vigente', 'Visto bueno de Protección Civil'], campos: 'Nombre del establecimiento|texto\nTipo de venta|lista|Envase cerrado,Consumo en el lugar\nDirección|texto', etapas: 'Revisión documental\nVerificación de Protección Civil\nAutorización\nEmisión de licencia' }
];
api.post('/procedures/plantillas', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const department = TOP.includes(q.user.role) ? q.body.department : q.user.department; if (!department) throw bad('Elige un departamento'); let creadas = 0;
  for (const p of PLANTILLAS) {
    if (await Procedure.exists({ nombre: p.nombre, department })) continue;
    await Procedure.create({ nombre: p.nombre, descripcion: p.descripcion, department, requisitos: p.requisitos.map(n => ({ nombre: n })), campos: parseCampos(p.campos), etapas: lines(p.etapas), slaDias: p.slaDias, costo: { tipo: p.costo > 0 ? 'fijo' : 'variable', monto: p.costo }, historialCostos: [{ monto: p.costo, por: q.user._id, fecha: new Date() }] }); creadas++;
  }
  s.json({ creadas });
}));
api.post('/cases/:id/etapa', auth, only(...STAFF), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), p = c.procedure ? await Procedure.findById(c.procedure) : null, et = p?.etapas || [];
  if (!et.length || c.etapa >= et.length) throw bad('Este trámite no tiene más etapas');
  c.historial.push({ estatus: c.estatus, por: q.user._id, nota: 'Etapa completada: ' + et[c.etapa] }); c.etapa += 1;
  if (c.estatus === 'Recibido') c.estatus = 'En proceso';
  if (c.etapa >= et.length && !['Pago pendiente', 'Pago en revisión'].includes(c.estatus)) { c.estatus = 'Resuelto'; c.cerradoEn = new Date(); }
  await c.save(); await notify([c.ciudadano], `${c.folio}: avanzó a "${et[c.etapa] || 'finalizado'}"`, c._id); s.json({ ok: 1 });
}));
api.get('/cuentas/mias', auth, only('ciudadano'), wrap(async (q, s) => s.json(await Cuenta.find({ ciudadano: q.user._id }))));
api.post('/cuentas/vincular', auth, only('ciudadano'), wrap(async (q, s) => {
  const { tipo, clave, titular } = q.body, c = await Cuenta.findOne({ tipo, clave: String(clave || '').trim().toUpperCase() }), t = String(titular || '').trim().toLowerCase();
  if (!c || t.length < 4 || !c.titular.toLowerCase().includes(t)) throw bad('No encontramos una cuenta con esos datos. Revisa tu recibo.');
  if (c.ciudadano && String(c.ciudadano) !== String(q.user._id)) throw bad('Esta cuenta ya está vinculada a otra persona. Acude a ventanilla.', 409);
  c.ciudadano = q.user._id; await c.save(); s.json(c);
}));
api.post('/cuentas/:id/pagar', auth, only('ciudadano'), wrap(async (q, s) => {
  const c = await Cuenta.findOne({ _id: q.params.id, ciudadano: q.user._id }); if (!c || !(c.adeudo > 0)) throw bad('Esta cuenta no tiene adeudo');
  const prev = await Case.findOne({ cuenta: c._id, ciudadano: q.user._id, estatus: { $in: ['Pago pendiente', 'Pago en revisión'] } }); if (prev) return s.json({ id: prev._id, folio: prev.folio });
  const dep = await Department.findOne({ nombre: /tesorer/i });
  const f = await Case.create({ folio: await nextFolio('tramite'), tipo: 'tramite', ciudadano: q.user._id, department: dep?._id, cuenta: c._id, titulo: `Pago de ${c.tipo} · ${c.clave}`, descripcion: c.direccion, costo: c.adeudo, estatus: 'Pago pendiente', slaVence: new Date(Date.now() + 5 * 864e5), historial: [{ estatus: 'Pago pendiente', por: q.user._id, nota: 'Creado desde Mis cuentas' }] });
  s.json({ id: f._id, folio: f.folio });
}));
api.get('/cuentas', auth, only(...CAJA), wrap(async (q, s) => s.json(await Cuenta.find().sort('tipo clave').limit(300))));
api.post('/cuentas/importar', auth, only(...CAJA), wrap(async (q, s) => {
  let n = 0; for (const l of lines(q.body.csv)) { const [tipo, clave, titular, direccion, adeudo] = l.split(',').map(x => x.trim()); if (!['predial', 'agua'].includes(tipo) || !clave) continue; await Cuenta.findOneAndUpdate({ tipo, clave: clave.toUpperCase() }, { titular, direccion, adeudo: +adeudo || 0 }, { upsert: true }); n++; }
  audit(q.user, 'importar_cuentas', { n }); s.json({ importadas: n });
}));
api.get('/participacion', wrap(async (q, s) => {
  const pr = await Propuesta.find().sort('-createdAt').limit(50).populate('autor', 'nombre').lean(), py = await Proyecto.find().sort('-createdAt').lean();
  s.json({ propuestas: pr.map(p => ({ ...p, apoyos: p.apoyos.length, autor: p.autor?.nombre?.split(' ')[0] })), proyectos: py.map(p => ({ ...p, votos: p.votos.length })), ronda: (await Ronda.findOne().lean()) || {} });
}));
api.post('/propuestas', auth, only('ciudadano'), wrap(async (q, s) => {
  const { titulo, descripcion } = q.body; if (!titulo || !descripcion) throw bad('Escribe el título y la descripción');
  s.json(await Propuesta.create({ titulo: String(titulo).slice(0, 120), descripcion: String(descripcion).slice(0, 1000), autor: q.user._id }));
}));
api.post('/propuestas/:id/apoyar', auth, only('ciudadano'), wrap(async (q, s) => {
  const r = await Propuesta.updateOne({ _id: q.params.id, apoyos: { $ne: q.user._id } }, { $addToSet: { apoyos: q.user._id } }); if (!r.modifiedCount) throw bad('Ya apoyaste esta propuesta'); s.json({ ok: 1 });
}));
api.post('/propuestas/:id/estatus', auth, only(...TOP), wrap(async (q, s) => {
  if (!['Abierta', 'En revisión', 'Aprobada', 'Rechazada'].includes(q.body.estatus)) throw bad('Estatus inválido');
  await Propuesta.updateOne({ _id: q.params.id }, { estatus: q.body.estatus, respuesta: String(q.body.respuesta || '').slice(0, 500) }); s.json({ ok: 1 });
}));
api.post('/proyectos', auth, only(...TOP), wrap(async (q, s) => { if (!q.body.titulo) throw bad('Falta el nombre'); s.json(await Proyecto.create({ titulo: q.body.titulo, descripcion: q.body.descripcion, costo: +q.body.costo || 0 })); }));
api.post('/ronda', auth, only(...TOP), wrap(async (q, s) => s.json(await Ronda.findOneAndUpdate({}, { abierta: !!q.body.abierta, presupuesto: +q.body.presupuesto || 0, votosPorPersona: +q.body.votosPorPersona || 3 }, { upsert: true, new: true }))));
api.post('/proyectos/:id/votar', auth, only('ciudadano'), wrap(async (q, s) => {
  const r = await Ronda.findOne(); if (!r?.abierta) throw bad('La votación no está abierta');
  if (await Proyecto.countDocuments({ votos: q.user._id }) >= (r.votosPorPersona || 3)) throw bad(`Solo puedes votar por ${r.votosPorPersona || 3} proyectos`);
  const u = await Proyecto.updateOne({ _id: q.params.id, votos: { $ne: q.user._id } }, { $addToSet: { votos: q.user._id } }); if (!u.modifiedCount) throw bad('Ya votaste por este proyecto'); s.json({ ok: 1 });
}));
api.post('/cases/:id/evidencia', auth, only(...STAFF), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), { foto, lat, lng, nota, cerrar, activo } = q.body, n = String(nota || '').slice(0, 300);
  c.evidencias.push({ foto: /^data:image\//.test(foto || '') ? foto : undefined, lat: +lat || undefined, lng: +lng || undefined, nota: n, por: q.user._id });
  if (cerrar) { c.estatus = 'Resuelto'; c.cerradoEn = new Date(); } else if (['Asignado', 'Recibido'].includes(c.estatus)) c.estatus = 'En proceso';
  c.historial.push({ estatus: c.estatus, por: q.user._id, nota: (cerrar ? 'Trabajo terminado en campo. ' : 'Visita en campo. ') + n }); await c.save();
  if (cerrar && activo) await Activo.updateOne({ codigo: String(activo).toUpperCase() }, { estado: 'Operando', ultimaAtencion: new Date() });
  await notify([c.ciudadano], `${c.folio}: ${cerrar ? 'el trabajo fue terminado' : 'una cuadrilla visitó el sitio'}`, c._id); s.json({ ok: 1 });
}));
api.get('/activos', auth, only(...STAFF), wrap(async (q, s) => s.json(await Activo.find(TOP.includes(q.user.role) ? {} : { department: q.user.department }).sort('codigo').limit(300).populate('department', 'nombre'))));
api.post('/activos', auth, only(...STAFF), wrap(async (q, s) => {
  const { tipo, codigo, descripcion, lat, lng, zona, department } = q.body; if (!codigo) throw bad('Falta el código');
  s.json(await Activo.findOneAndUpdate({ codigo: String(codigo).toUpperCase() }, { tipo, descripcion, lat: +lat || undefined, lng: +lng || undefined, zona, department: TOP.includes(q.user.role) ? department : q.user.department }, { upsert: true, new: true }));
}));
api.post('/activos/:id/estado', auth, only(...STAFF), wrap(async (q, s) => {
  const a = await Activo.findById(q.params.id); if (!a || !canDept(q.user, a.department)) throw bad('No encontrado', 404);
  if (!['Operando', 'Falla', 'Baja'].includes(q.body.estado)) throw bad('Estado inválido'); a.estado = q.body.estado; await a.save(); s.json(a);
}));
api.get('/verificar/:folio', wrap(async (q, s) => {
  const c = await Case.findOne({ folio: q.params.folio }).select('folio tipo titulo estatus createdAt'); c ? s.json(c) : s.status(404).json({ error: 'Folio no encontrado' });
}));

// --- Dashboard (mismo alcance jerárquico que la lista de casos)
api.get('/stats', auth, only(...STAFF), wrap(async (q, s) => {
  const f = scope(q.user), now = new Date();
  const grp = k => Case.aggregate([{ $match: f }, { $group: { _id: '$' + k, n: { $sum: 1 }, abiertos: { $sum: { $cond: [{ $in: ['$estatus', FINAL] }, 0, 1] } } } }]);
  const [est, dep, per, vencidos, t] = await Promise.all([
    grp('estatus'), grp('department'), grp('asignadoA'),
    Case.countDocuments({ $and: [f, { estatus: { $nin: FINAL }, slaVence: { $lt: now } }] }),
    Case.aggregate([{ $match: { ...f, cerradoEn: { $ne: null } } }, { $group: { _id: null, h: { $avg: { $divide: [{ $subtract: ['$cerradoEn', '$createdAt'] }, 36e5] } } } }])
  ]);
  const D = Object.fromEntries((await Department.find()).map(d => [d._id, d.nombre])), U = Object.fromEntries((await User.find({ role: { $ne: 'ciudadano' } })).map(u => [u._id, u.nombre]));
  const sat = await Case.aggregate([{ $match: { ...f, calificacion: { $gt: 0 } } }, { $group: { _id: '$department', prom: { $avg: '$calificacion' }, n: { $sum: 1 } } }]);
  const rec = ['admin', 'presidente', 'director'].includes(q.user.role) ? (await Payment.aggregate([{ $match: q.user.role === 'director' ? { department: q.user.department } : {} }, { $group: { _id: null, t: { $sum: '$monto' } } }]))[0]?.t || 0 : 0;
  s.json({
    total: est.reduce((a, x) => a + x.n, 0), vencidos, recaudado: rec, satisfaccion: sat.map(x => ({ nombre: D[x._id] || '—', prom: Math.round(x.prom * 10) / 10, n: x.n })), horasPromedio: Math.round(t[0]?.h || 0),
    porEstatus: est.map(x => ({ nombre: x._id, n: x.n })),
    porDepartamento: dep.map(x => ({ nombre: D[x._id] || 'Sin clasificar', n: x.n, abiertos: x.abiertos })),
    porPersona: per.map(x => ({ nombre: U[x._id] || 'Sin asignar', n: x.n, abiertos: x.abiertos }))
  });
}));

// --- Notificaciones y mensajería interna
api.get('/notifications', auth, wrap(async (q, s) => s.json(await Notification.find({ user: q.user._id }).sort('-createdAt').limit(30))));
api.post('/notifications/leer', auth, wrap(async (q, s) => { await Notification.updateMany({ user: q.user._id }, { leida: true }); s.json({ ok: 1 }); }));
api.get('/contactos', auth, only(...STAFF), wrap(async (q, s) => s.json(await User.find({ role: { $ne: 'ciudadano' }, activo: true, _id: { $ne: q.user._id } }).select('nombre role'))));
const canalOk = (u, c) => c === 'circular' || (c.startsWith('dm:') && c.slice(3).split('_').includes(String(u._id))) || (c.startsWith('dept:') && (TOP.includes(u.role) || c.slice(5) === String(u.department)));
api.get('/mensajes', auth, only(...STAFF), wrap(async (q, s) => {
  const canal = q.query.canal || ''; if (!canalOk(q.user, canal)) throw bad('Canal no permitido', 403);
  s.json((await Message.find({ canal }).sort('-createdAt').limit(100).populate('de', 'nombre')).reverse());
}));
api.post('/mensajes', auth, only(...STAFF), wrap(async (q, s) => {
  const { canal = '', texto } = q.body; if (!texto || !canalOk(q.user, canal)) throw bad('Mensaje no válido', 403);
  if (canal === 'circular' && !TOP.includes(q.user.role)) throw bad('Solo el presidente envía circulares', 403);
  const m = await (await Message.create({ canal, texto, de: q.user._id, circular: canal === 'circular' })).populate('de', 'nombre');
  const rooms = canal === 'circular' ? ['staff'] : canal.startsWith('dept:') ? ['d:' + canal.slice(5)] : canal.slice(3).split('_').map(id => 'u:' + id);
  rooms.forEach(r => io.to(r).emit('msg', m)); s.json(m);
}));
api.post('/mensajes/:id/leer', auth, only(...STAFF), wrap(async (q, s) => { await Message.updateOne({ _id: q.params.id }, { $addToSet: { leidoPor: q.user._id } }); s.json({ ok: 1 }); }));

// --- Tiempo real
io.use((sock, next) => {
  try { const { id } = jwt.verify(sock.handshake.auth.token, SECRET); User.findById(id).then(u => u ? (sock.user = u, next()) : next(new Error('auth'))); }
  catch { next(new Error('auth')); }
});
io.on('connection', sock => {
  const u = sock.user; sock.join('u:' + u._id);
  if (u.role !== 'ciudadano') { sock.join('staff'); if (u.department) sock.join('d:' + u.department); }
});

// --- Escalamiento automático: coordinador -> director -> presidente cuando vence el plazo
async function escalar() {
  const now = new Date();
  for (const c of await Case.find({ estatus: { $nin: FINAL }, slaVence: { $lt: now }, nivelEscalado: { $lt: 3 } }).populate('category procedure')) {
    const base = c.tipo === 'reporte' ? (c.category?.slaHoras || 48) * 36e5 : (c.procedure?.slaDias || 5) * 864e5, over = now - c.slaVence;
    const nivel = over > base ? 3 : over > base / 2 ? 2 : 1; if (nivel <= c.nivelEscalado) continue;
    const dest = nivel === 1 ? c.coordinador : nivel === 2 ? c.director : (await User.findOne({ role: 'presidente' }))?._id;
    c.nivelEscalado = nivel; await c.save(); await notify([dest], `⚠ Vencido: ${c.folio} (escalado nivel ${nivel})`, c._id);
  }
}

mongoose.connect(process.env.MONGODB_URI).then(() => {
  server.listen(process.env.PORT || 3000, () => console.log('Oficina Virtual en línea'));
  setInterval(() => { escalar().catch(console.error); recordar().catch(console.error); }, 10 * 60 * 1000);
}).catch(e => { console.error('Error de MongoDB:', e.message); process.exit(1); });

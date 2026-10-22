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
import { User, Department, Category, Procedure, Case, Counter, Notification, Message, Audit, Payment, Aviso, Obra, Sesion, Cita, Inhabil, Cuenta, Propuesta, Proyecto, Ronda, Activo, Egreso, Presupuesto, Infraccion, Multa, Ajuste } from './models.js';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') { console.error('Falta la variable JWT_SECRET'); process.exit(1); }
const SECRET = process.env.JWT_SECRET || 'cambia-esto';
const SIN_CLAVE = process.env.SIN_CLAVE === 'true'; // MODO DE PRUEBA: permite entrar con la contraseña en blanco
const passOk = async (u, pw) => (SIN_CLAVE && !pw) || bcrypt.compare(pw || '', u.password);
const app = express(), server = http.createServer(app), io = new Server(server);
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
app.get('/health', (q, r) => r.send('ok'));

const STAFF = ['admin', 'presidente', 'director', 'coordinador', 'encargado'];
const TOP = ['admin', 'presidente'];
const fotoOk = f => typeof f === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(f) && f.length < 2e6;
const FINAL = ['Resuelto', 'Cerrado', 'Entregado', 'Rechazado', 'Cancelado'];
const ESTATUS = {
  reporte: ['Sin clasificar', 'Recibido', 'Asignado', 'En proceso', 'Resuelto', 'Cerrado', 'Rechazado'],
  tramite: ['Recibido', 'En revisión', 'Prevención', 'En proceso', 'Pago pendiente', 'Pago en revisión', 'Pagado', 'Resuelto', 'Entregado', 'Rechazado', 'Cancelado']
};
const CREA = { admin: ['presidente', 'director', 'coordinador', 'encargado', 'caja', 'tesorero', 'agente'], presidente: ['director', 'caja', 'tesorero', 'agente'], director: ['coordinador', 'encargado', 'agente'], coordinador: ['encargado'] };

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(e => { if (!e.status) console.error(e); s.status(e.status || (e.code === 11000 ? 409 : 500)).json({ error: e.status ? e.message : e.code === 11000 ? 'Ese registro ya existe o el horario ya fue tomado' : 'Error del servidor' }); });
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
  if (c.multa) { await Multa.updateOne({ _id: c.multa }, { estatus: 'Pagada', pagadaEn: new Date() }); c.estatus = 'Resuelto'; c.cerradoEn = new Date(); await c.save(); }
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
  caja: { _id: null },
  tesorero: { _id: null },
  agente: { _id: null }
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
    fotos: (b.fotos || []).filter(fotoOk).slice(0, 5),
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
api.use(rateLimit({ windowMs: 60 * 1000, max: +process.env.RATE_MAX || 600 }));
api.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));

// --- Autenticación
api.post('/auth/register', wrap(async (q, s) => {
  const { nombre, email, password, telefono, acepto } = q.body;
  if (!acepto) throw bad('Debes aceptar el aviso de privacidad');
  if (!nombre || !email || (!SIN_CLAVE && (!password || password.length < 8))) throw bad('Datos incompletos (contraseña mínimo 8)');
  if (await User.findOne({ email: email.toLowerCase() })) throw bad('Correo ya registrado', 409);
  const u = await User.create({ nombre, email, telefono, password: await bcrypt.hash(password || '', 10), role: 'ciudadano', consentimiento: new Date() });
  const t = crypto.randomBytes(24).toString('hex'); u.verifHash = hash(t); await u.save();
  sendMail(u.email, 'Confirma tu correo', `Confirma tu correo aquí: ${base(q)}/?verificar_correo=${t}`);
  s.json({ token: sign(u), user: pub(u) });
}));
api.post('/auth/login', wrap(async (q, s) => {
  const u = await User.findOne({ email: String(q.body.email || '').toLowerCase() });
  if (!u || !u.activo || !(await passOk(u, q.body.password))) throw bad('Credenciales incorrectas', 401);
  s.json({ token: sign(u), user: pub(u) });
}));
api.get('/auth/me', auth, (q, s) => s.json(pub(q.user)));

// --- Estructura: departamentos, personal, categorías
api.get('/departments', auth, only(...STAFF, 'caja', 'tesorero'), wrap(async (q, s) => s.json(await Department.find().populate('director', 'nombre'))));
api.post('/departments', auth, only(...TOP), wrap(async (q, s) => {
  if (!q.body.nombre) throw bad('Falta nombre'); const d = await Department.create({ nombre: q.body.nombre }); audit(q.user, 'crear_depto', d._id); s.json(d);
}));
api.post('/users', auth, only(...Object.keys(CREA)), wrap(async (q, s) => {
  const { nombre, email, password, role, department } = q.body, me = q.user;
  if (!CREA[me.role].includes(role)) throw bad('No puedes crear ese rol', 403);
  if (!nombre || !email || (!SIN_CLAVE && (!password || password.length < 8))) throw bad('Datos incompletos (contraseña mínimo 8)');
  if (await User.findOne({ email: email.toLowerCase() })) throw bad('Correo ya registrado', 409);
  const dept = TOP.includes(me.role) ? department : me.department;
  if (!['presidente', 'caja', 'tesorero', 'agente'].includes(role) && !dept) throw bad('Falta departamento');
  const u = await User.create({ nombre, email, password: await bcrypt.hash(password || '', 10), role, department: ['presidente', 'caja', 'tesorero', 'agente'].includes(role) ? undefined : dept, parent: me._id });
  if (role === 'director') await Department.findByIdAndUpdate(dept, { director: u._id });
  audit(me, 'crear_usuario', { id: u._id, role }); s.json(pub(u));
}));
api.get('/users', auth, only(...STAFF), wrap(async (q, s) => {
  // Cada quien ve a su gente: presidencia todo, el director su departamento, coordinador/encargado solo a su equipo directo
  const me = q.user, f = { role: { $ne: 'ciudadano' } };
  if (me.role === 'director') f.department = me.department;
  else if (!TOP.includes(me.role)) f.$or = [{ _id: me._id }, { parent: me._id }];
  s.json(await User.find(f).select('-password').populate('department', 'nombre'));
}));
api.patch('/users/:id/activo', auth, only(...Object.keys(CREA)), wrap(async (q, s) => {
  const u = await User.findById(q.params.id);
  if (!u || !CREA[q.user.role].includes(u.role) || (!TOP.includes(q.user.role) && String(u.department) !== String(q.user.department)) || (q.user.role === 'coordinador' && String(u.parent) !== String(q.user._id))) throw bad('Sin permiso', 403);
  u.activo = !u.activo; await u.save(); audit(q.user, 'activo_usuario', { id: u._id, activo: u.activo }); s.json({ activo: u.activo });
}));
api.post('/categories', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const { nombre, subcategorias, department, slaHoras } = q.body; if (!nombre) throw bad('Falta nombre');
  s.json(await Category.create({ nombre, subcategorias: subcategorias || [], department: q.user.role === 'director' ? q.user.department : department, slaHoras: slaHoras || 48 }));
}));
api.get('/catalog', wrap(async (q, s) => s.json({ categorias: await Category.find(), tramites: await Procedure.find({ activo: true }).populate('department', 'nombre') })));

// --- Trámites (catálogo por departamento; el cambio de precio lo aprueba el director)
api.get('/procedures', auth, only(...STAFF), wrap(async (q, s) => s.json(await Procedure.find(TOP.includes(q.user.role) ? {} : { department: q.user.department }).populate('department', 'nombre'))));
api.post('/procedures', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const { nombre, descripcion, requisitos, costo, slaDias, department, fundamento } = q.body, me = q.user; if (!nombre) throw bad('Falta nombre');
  const m = +costo || 0, aprueba = ['admin', 'presidente', 'director'].includes(me.role);
  const p = await Procedure.create({
    nombre, descripcion, department: TOP.includes(me.role) ? department : me.department,
    requisitos: (requisitos || []).map(n => ({ nombre: n })), campos: parseCampos(q.body.campos), etapas: lines(q.body.etapas), grupo: q.body.grupo || 'Otros', clase: q.body.clase === 'servicio' ? 'servicio' : 'tramite', slaDias: slaDias || 5,
    costo: { tipo: aprueba && m > 0 ? 'fijo' : 'gratis', monto: aprueba ? m : 0, fundamento: String(fundamento || '').slice(0, 200) },
    costoPendiente: !aprueba && m ? { monto: m, por: me._id } : undefined,
    historialCostos: aprueba ? [{ monto: m, por: me._id, fecha: new Date() }] : []
  });
  audit(me, 'crear_tramite', p._id); s.json(p);
}));
api.put('/procedures/:id', auth, only(...STAFF), wrap(async (q, s) => {
  const p = await Procedure.findById(q.params.id); if (!p || !canDept(q.user, p.department)) throw bad('No encontrado', 404);
  const aprueba = ['admin', 'presidente', 'director'].includes(q.user.role), b = aprueba ? q.body : { costo: q.body.costo };
  ['nombre', 'descripcion', 'slaDias', 'activo', 'grupo', 'clase'].forEach(k => b[k] !== undefined && (p[k] = b[k]));
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
  const c = await getCase(q, q.params.id), { estatus, nota, foto } = q.body;
  if (!ESTATUS[c.tipo].includes(estatus) || estatus === 'Sin clasificar') throw bad('Estatus inválido');
  // En reportes (luminarias, baches, fugas…) la foto de evidencia es obligatoria al pasar a "En proceso" y a "Resuelto"
  if (c.tipo === 'reporte' && ['En proceso', 'Resuelto'].includes(estatus) && c.estatus !== estatus) {
    if (!fotoOk(foto)) throw bad(`Para marcar "${estatus}" sube una foto de evidencia`);
    c.evidencias.push({ foto, etapa: estatus, nota: String(nota || '').slice(0, 300), por: q.user._id });
  }
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
  if (q.user.role === 'coordinador' && String(u._id) !== String(q.user._id) && String(u.parent) !== String(q.user._id)) throw bad('Solo puedes asignar a tu equipo', 403);
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
api.get('/pagos', auth, only('admin', 'presidente', 'director', 'caja', 'tesorero'), wrap(async (q, s) => {
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
api.get('/config', (q, s) => s.json({ nombre: process.env.MUNICIPIO || 'Ayuntamiento Municipal', lema: process.env.LEMA || 'Gobierno cercano a ti', color: process.env.COLOR || '', mp: !!process.env.MP_ACCESS_TOKEN, sinClave: SIN_CLAVE, clabe: process.env.CLABE || '', banco: process.env.BANCO || '', titular: process.env.TITULAR || '' }));
api.get('/avisos', wrap(async (q, s) => s.json(await Aviso.find({ activo: true }).sort('-createdAt').limit(8))));
api.post('/avisos', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const { titulo, texto, tipo } = q.body; if (!titulo || !texto) throw bad('Faltan título o texto');
  const a = await Aviso.create({ titulo, texto, tipo: ['aviso', 'obra', 'alerta'].includes(tipo) ? tipo : 'aviso', autor: q.user._id, zona: q.body.zona || 'Todo el municipio' }); if (a.tipo === 'alerta') io.emit('alerta', a); audit(q.user, 'aviso', a._id); s.json(a);
}));
const CAJA = ['admin', 'presidente', 'caja', 'tesorero'];
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
  u.password = await bcrypt.hash(password || '', 10); u.resetHash = undefined; u.resetExp = undefined; await u.save(); s.json({ ok: 1 });
}));
api.post('/auth/verificar-correo', wrap(async (q, s) => {
  const u = await User.findOne({ verifHash: hash(String(q.body.token || '')) }); if (!u) throw bad('El enlace no es válido');
  u.correoVerificado = true; u.verifHash = undefined; await u.save(); s.json({ ok: 1 });
}));
api.post('/cases/ventanilla', auth, only(...STAFF), wrap(async (q, s) => {
  const { nombre, telefono, email, tipo } = q.body; if (!nombre || !['reporte', 'tramite'].includes(tipo)) throw bad('Captura el nombre del ciudadano y el tipo de solicitud');
  if (tipo === 'reporte' && !q.body.descripcion) throw bad('Describe el problema');
  // Cada área solo captura lo que le corresponde
  if (!TOP.includes(q.user.role)) {
    const d = tipo === 'tramite' ? (await Procedure.findById(q.body.procedure))?.department : q.body.category ? (await Category.findById(q.body.category))?.department : null;
    if (d && String(d) !== String(q.user.department)) throw bad('Ese trámite o categoría no es de tu departamento', 403);
  }
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
  if (!(await passOk(q.user, q.body.password))) throw bad('Contraseña incorrecta', 401);
  const u = q.user; Object.assign(u, { nombre: 'Usuario eliminado', telefono: '', email: `eliminado-${u._id}@invalid.local`, password: await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 10), activo: false, sinCorreos: true });
  await u.save(); audit(u, 'arco_cancelacion', {}); s.json({ ok: 1 });
}));
const lines = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
const parseCampos = v => lines(v).map((l, i) => { const [label, tipo = 'texto', op = ''] = l.split('|').map(x => x.trim()); return { id: 'c' + i, label, tipo: ['texto', 'numero', 'fecha', 'lista'].includes(tipo) ? tipo : 'texto', obligatorio: true, opciones: op ? op.split(',').map(x => x.trim()) : [] }; });
const [S_, E_, O_, A_, V_, P_, DS_, T_] = ['Secretaría del Ayuntamiento', 'Desarrollo Económico', 'Obras Públicas', 'Agua Potable', 'Servicios Públicos', 'Protección Civil', 'Desarrollo Social', 'Tesorería'];
// [grupo, departamento, nombre, descripción, costo, días hábiles, requisitos (|), campos (\n, Etiqueta|tipo|opciones), etapas (|), clase]
// Los costos quedan en 0 ("por definir"): cada municipio los fija según su ley de ingresos.
const PLANTILLAS = [
  ['Constancias', S_, 'Constancia de residencia', 'Acredita tu domicilio en el municipio.', 0, 3, 'Identificación oficial|Comprobante de domicilio', 'Domicilio completo|texto\nAños viviendo en el municipio|numero', 'Revisión documental|Emisión de constancia', 'tramite'],
  ['Constancias', S_, 'Constancia de origen y vecindad', 'Acredita que eres originario o vecino del municipio.', 0, 3, 'Identificación oficial|Acta de nacimiento|Comprobante de domicilio', 'Comunidad o colonia|texto\nAños de residencia|numero', 'Revisión documental|Emisión de constancia', 'tramite'],
  ['Constancias', S_, 'Constancia de identidad', 'Confirma tu identidad ante el ayuntamiento.', 0, 3, 'Dos fotografías tamaño infantil|Acta de nacimiento|Comprobante de domicilio', 'Motivo de la constancia|lista|Trámite escolar,Trámite laboral,Trámite bancario,Otro', 'Revisión documental|Emisión de constancia', 'tramite'],
  ['Constancias', S_, 'Constancia de dependencia económica', 'Acredita que dependes económicamente de otra persona.', 0, 3, 'Identificación oficial de ambas personas|Acta de nacimiento|Comprobante de domicilio', 'Nombre de quien te sostiene|texto\nParentesco|lista|Padre o madre,Cónyuge,Hijo o hija,Otro', 'Revisión documental|Emisión de constancia', 'tramite'],
  ['Constancias', S_, 'Cartilla del Servicio Militar Nacional', 'Solicitud de cartilla para jóvenes de 18 años.', 0, 10, 'Acta de nacimiento|CURP|Comprobante de domicilio|Cuatro fotografías|Comprobante de estudios', 'Año de nacimiento|numero', 'Revisión documental|Registro|Entrega de cartilla', 'tramite'],
  ['Constancias', S_, 'Solicitud de audiencia con el presidente municipal', 'Pide una audiencia para exponer un asunto.', 0, 10, '', 'Asunto|lista|Obra pública,Servicios,Seguridad,Apoyos,Otro\nResumen breve|texto', 'Registro de la solicitud|Agenda de la audiencia', 'servicio'],
  ['Constancias', S_, 'Solicitud de acceso a la información pública', 'Pide información generada por el ayuntamiento.', 0, 10, '', 'Información que solicitas|texto\nÁrea que la genera|texto', 'Registro|Búsqueda de información|Respuesta al solicitante', 'servicio'],
  ['Tesorería', T_, 'Constancia de no adeudo predial', 'Acredita que tu predial está al corriente.', 0, 3, 'Identificación oficial|Último recibo de predial', 'Clave catastral|texto', 'Verificación de adeudo|Emisión de constancia', 'tramite'],
  ['Tesorería', T_, 'Convenio de pago en parcialidades', 'Solicita pagar tus adeudos en pagos parciales.', 0, 5, 'Identificación oficial|Recibo o estado de adeudo', 'Tipo de adeudo|lista|Predial,Agua,Multa,Otro\nPlazo deseado|lista|3 meses,6 meses,12 meses', 'Revisión del adeudo|Autorización|Firma del convenio', 'servicio'],
  ['Licencias y permisos', E_, 'Licencia de funcionamiento SARE (bajo riesgo)', 'Apertura rápida de negocios de bajo riesgo.', 0, 2, 'Identificación oficial|CURP|Comprobante de domicilio del negocio', 'Nombre del negocio|texto\nGiro o actividad|texto\nDirección del negocio|texto\nSuperficie en m²|numero', 'Revisión documental|Verificación del giro|Emisión de licencia', 'tramite'],
  ['Licencias y permisos', E_, 'Renovación de licencia de funcionamiento', 'Renueva tu licencia anual.', 0, 3, 'Licencia anterior|Identificación oficial|Comprobante de pago del año previo', 'Número de licencia anterior|texto', 'Revisión documental|Emisión de licencia', 'tramite'],
  ['Licencias y permisos', E_, 'Licencia para venta de alcohol', 'Autorización para venta de bebidas alcohólicas.', 0, 20, 'Identificación oficial|Licencia de funcionamiento vigente|Visto bueno de Protección Civil', 'Nombre del establecimiento|texto\nTipo de venta|lista|Envase cerrado,Consumo en el lugar\nDirección|texto', 'Revisión documental|Verificación de Protección Civil|Autorización|Emisión de licencia', 'tramite'],
  ['Licencias y permisos', E_, 'Permiso de comercio en vía pública', 'Permiso para vender en tianguis, calle o plaza.', 0, 10, 'Identificación oficial|Comprobante de domicilio|Fotografía del puesto', 'Producto que vendes|texto\nUbicación solicitada|texto\nDías de venta|lista|Diario,Fines de semana,Tianguis', 'Revisión documental|Asignación de lugar|Emisión de permiso', 'tramite'],
  ['Licencias y permisos', E_, 'Licencia de anuncios publicitarios', 'Permiso para colocar anuncios o espectaculares.', 0, 10, 'Identificación oficial|Croquis del anuncio|Fotografía del lugar', 'Tipo de anuncio|lista|Mural,Lona,Espectacular,Letrero luminoso\nMedidas en metros|texto', 'Revisión documental|Inspección|Emisión de licencia', 'tramite'],
  ['Licencias y permisos', P_, 'Permiso para evento social o público', 'Autorización para fiestas, bailes o eventos masivos.', 0, 8, 'Identificación oficial|Comprobante del lugar|Plan de seguridad (si aplica)', 'Tipo de evento|lista|Fiesta privada,Baile público,Evento deportivo,Feria\nFecha del evento|fecha\nPersonas esperadas|numero', 'Revisión documental|Visto bueno de Protección Civil|Emisión de permiso', 'tramite'],
  ['Obras y desarrollo urbano', O_, 'Licencia de construcción', 'Permiso para construir, ampliar o remodelar.', 0, 15, 'Escritura o título de propiedad|Planos firmados|Identificación oficial|Predial al corriente', 'Clave catastral|texto\nTipo de obra|lista|Construcción nueva,Ampliación,Remodelación\nMetros cuadrados|numero', 'Revisión documental|Inspección en sitio|Cálculo de derechos|Emisión de licencia', 'tramite'],
  ['Obras y desarrollo urbano', O_, 'Alineamiento y número oficial', 'Define el alineamiento de tu predio y su número.', 0, 8, 'Escritura o título de propiedad|Predial al corriente|Croquis de ubicación', 'Clave catastral|texto\nCalle del predio|texto', 'Revisión documental|Inspección|Emisión de constancia', 'tramite'],
  ['Obras y desarrollo urbano', O_, 'Constancia de uso de suelo', 'Confirma el uso permitido para tu predio.', 0, 10, 'Escritura o título de propiedad|Croquis de ubicación|Identificación oficial', 'Clave catastral|texto\nUso que pretendes|lista|Casa habitación,Comercio,Industria,Servicios', 'Revisión documental|Revisión técnica|Emisión de constancia', 'tramite'],
  ['Obras y desarrollo urbano', O_, 'Permiso de ruptura de pavimento', 'Permiso para abrir calle o banqueta.', 0, 5, 'Identificación oficial|Croquis de la obra|Autorización del organismo de agua', 'Calle y colonia|texto\nMetros lineales|numero\nMotivo|lista|Toma de agua,Drenaje,Energía eléctrica,Otro', 'Revisión documental|Inspección|Emisión de permiso', 'tramite'],
  ['Agua', A_, 'Contrato de toma de agua nueva', 'Solicita conexión al servicio de agua potable.', 0, 10, 'Identificación oficial|Escritura o título de propiedad|Comprobante de domicilio', 'Clave catastral|texto\nUso|lista|Doméstico,Comercial,Industrial', 'Revisión documental|Inspección|Cálculo de derechos|Instalación', 'tramite'],
  ['Agua', A_, 'Reconexión del servicio de agua', 'Solicita reconectar el servicio suspendido.', 0, 3, 'Identificación oficial|Comprobante de pago o convenio', 'Número de contrato|texto', 'Verificación de pago|Reconexión', 'servicio'],
  ['Agua', A_, 'Solicitud de pipa de agua', 'Pide el envío de una pipa a tu domicilio.', 0, 2, 'Identificación oficial', 'Dirección de entrega|texto\nCapacidad|lista|5,000 litros,10,000 litros\nUso|lista|Doméstico,Evento,Obra', 'Registro|Programación de entrega|Entrega', 'servicio'],
  ['Agua', A_, 'Aclaración de recibo de agua', 'Pide revisar un cobro de agua.', 0, 5, 'Recibo en cuestión|Identificación oficial', 'Número de contrato|texto\nMotivo|lista|Cobro excesivo,Lectura incorrecta,Sin servicio,Otro', 'Registro|Revisión de lectura|Respuesta', 'servicio'],
  ['Servicios urbanos', V_, 'Poda o tala de árbol', 'Solicita poda o retiro de un árbol.', 0, 10, 'Identificación oficial|Fotografía del árbol', 'Dirección del árbol|texto\nSolicitud|lista|Poda,Tala,Retiro de árbol caído\nRiesgo|lista|Sin riesgo,Cerca de cables,Riesgo para viviendas', 'Registro|Inspección|Programación del trabajo|Ejecución', 'servicio'],
  ['Servicios urbanos', V_, 'Recolección de residuos voluminosos', 'Pide el retiro de muebles, escombro o ramas.', 0, 5, 'Identificación oficial', 'Dirección|texto\nTipo de residuo|lista|Muebles,Escombro,Ramas y podas,Electrodomésticos', 'Registro|Programación|Recolección', 'servicio'],
  ['Servicios urbanos', V_, 'Servicio de panteón (inhumación o exhumación)', 'Trámite para servicios del panteón municipal.', 0, 5, 'Identificación oficial|Acta de defunción|Comprobante de propiedad del lugar', 'Servicio|lista|Inhumación,Exhumación,Refrendo\nPanteón|texto', 'Revisión documental|Programación|Servicio', 'tramite'],
  ['Protección civil', P_, 'Visto bueno de Protección Civil', 'Dictamen de seguridad para negocios o eventos.', 0, 8, 'Identificación oficial|Croquis del lugar|Extintores vigentes', 'Tipo de lugar|lista|Negocio,Escuela,Evento,Otro\nAforo máximo|numero', 'Revisión documental|Inspección|Emisión de visto bueno', 'tramite'],
  ['Apoyos sociales', DS_, 'Solicitud de apoyo social', 'Pide apoyos del ayuntamiento para tu familia.', 0, 10, 'Identificación oficial|Comprobante de domicilio|Comprobante de ingresos o estudio socioeconómico', 'Tipo de apoyo|lista|Despensa,Material de construcción,Apoyo médico,Apoyo escolar\nPersonas en tu hogar|numero', 'Registro|Estudio socioeconómico|Resolución|Entrega del apoyo', 'servicio']
];
api.post('/procedures/plantillas', auth, only('admin', 'presidente', 'director'), wrap(async (q, s) => {
  const mi = TOP.includes(q.user.role) ? null : await Department.findById(q.user.department); let creadas = 0, actualizadas = 0, departamentos = 0;
  for (const [grupo, dn, nombre, descripcion, costo, slaDias, req, campos, etapas, clase] of PLANTILLAS) {
    if (mi && mi.nombre !== dn) continue;
    let dep = await Department.findOne({ nombre: dn }); if (!dep) { dep = await Department.create({ nombre: dn }); departamentos++; }
    const ex = await Procedure.findOne({ nombre, department: dep._id });
    if (ex) { if (!ex.grupo || (!ex.campos?.length && !ex.etapas?.length)) { Object.assign(ex, { grupo: ex.grupo || grupo, clase: ex.clase || clase }); if (!ex.campos?.length) ex.campos = parseCampos(campos); if (!ex.etapas?.length) ex.etapas = lines(etapas.split('|')); await ex.save(); actualizadas++; } continue; }
    await Procedure.create({ nombre, descripcion, grupo, clase, department: dep._id, requisitos: lines(req.split('|')).map(n => ({ nombre: n })), campos: parseCampos(campos), etapas: lines(etapas.split('|')), slaDias, costo: { tipo: 'variable', monto: costo, fundamento: '' }, historialCostos: [{ monto: costo, por: q.user._id, fecha: new Date() }] }); creadas++;
  }
  s.json({ creadas, actualizadas, departamentos });
}));
api.post('/cases/:id/costo', auth, only(...STAFF), wrap(async (q, s) => {
  const c = await getCase(q, q.params.id), p = c.procedure ? await Procedure.findById(c.procedure) : null, m = +q.body.monto;
  if (c.tipo !== 'tramite' || !p || !(m > 0)) throw bad('Indica un monto válido para un trámite');
  if (p.costo.tipo !== 'variable' && c.costo > 0) throw bad('El costo de este trámite es fijo; se cambia en el catálogo');
  c.costo = m; c.estatus = 'Pago pendiente'; c.historial.push({ estatus: c.estatus, por: q.user._id, nota: `Monto a pagar: $${m}` }); await c.save();
  await notify([c.ciudadano], `${c.folio}: ya puedes pagar $${m}`, c._id); audit(q.user, 'fijar_monto', { folio: c.folio, m }); s.json({ ok: 1 });
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
  if (c.tipo === 'reporte' && !fotoOk(foto)) throw bad(cerrar ? 'Sube la foto del trabajo terminado' : 'Sube una foto del sitio');
  c.evidencias.push({ foto: fotoOk(foto) ? foto : undefined, etapa: cerrar ? 'Resuelto' : 'En proceso', lat: +lat || undefined, lng: +lng || undefined, nota: n, por: q.user._id });
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
const RUBROS = ['Nómina', 'Servicios básicos', 'Obra pública', 'Materiales y suministros', 'Combustible', 'Mantenimiento', 'Apoyos sociales', 'Servicios profesionales', 'Otros'];
const TES = ['admin', 'presidente', 'tesorero'], PAGA = ['admin', 'tesorero', 'caja'], anioAct = () => new Date().getFullYear();
async function estadoPresupuesto(dept) {
  const anio = anioAct(), deps = await Department.find(dept ? { _id: dept } : {}), pres = await Presupuesto.find({ anio });
  const eg = (await Egreso.find({ estatus: { $in: ['Autorizado', 'Pagado'] }, ...(dept ? { department: dept } : {}) }).select('department monto estatus fecha').lean()).filter(e => new Date(e.fecha).getFullYear() === anio);
  return deps.map(d => { const mine = eg.filter(e => String(e.department) === String(d._id)), p = pres.find(x => String(x.department) === String(d._id))?.monto || 0, comp = mine.reduce((a, e) => a + e.monto, 0); return { department: d._id, nombre: d.nombre, presupuesto: p, comprometido: comp, pagado: mine.filter(e => e.estatus === 'Pagado').reduce((a, e) => a + e.monto, 0), disponible: p - comp }; });
}
api.get('/egresos', auth, only('admin', 'presidente', 'tesorero', 'caja', 'director'), wrap(async (q, s) => s.json(await Egreso.find(q.user.role === 'director' ? { department: q.user.department } : {}).select('-soporte -comprobantePago').sort('-createdAt').limit(300).populate('department', 'nombre'))));
api.get('/egresos/:id/documentos', auth, only('admin', 'presidente', 'tesorero', 'caja', 'director'), wrap(async (q, s) => {
  const e = await Egreso.findById(q.params.id).select('soporte comprobantePago department'); if (!e || (q.user.role === 'director' && String(e.department) !== String(q.user.department))) throw bad('No encontrado', 404);
  s.json({ soporte: e.soporte, comprobantePago: e.comprobantePago });
}));
api.post('/egresos', auth, only('admin', 'presidente', 'tesorero', 'director'), wrap(async (q, s) => {
  const { concepto, proveedor, rubro, monto, fecha, factura, soporte } = q.body, m = +monto, department = q.user.role === 'director' ? q.user.department : q.body.department;
  if (!concepto || !(m > 0) || !department || !RUBROS.includes(rubro)) throw bad('Completa concepto, rubro, departamento y un monto mayor a cero');
  if (soporte && !/^data:(image|application\/pdf)/.test(soporte)) throw bad('El soporte debe ser imagen o PDF');
  const y = anioAct(), n = await Counter.findByIdAndUpdate('egreso-' + y, { $inc: { n: 1 } }, { upsert: true, new: true });
  const e = await Egreso.create({ folio: `EGR-${y}-${String(n.n).padStart(6, '0')}`, concepto: String(concepto).slice(0, 200), proveedor: String(proveedor || '').slice(0, 120), rubro, department, monto: m, fecha: fecha ? new Date(fecha) : new Date(), factura: String(factura || '').slice(0, 60), soporte, solicitadoPor: q.user._id });
  await notify((await User.find({ role: 'tesorero', activo: true })).map(u => u._id), `Nueva solicitud de gasto ${e.folio}: $${m} · ${e.concepto}`); audit(q.user, 'egreso_solicitar', { folio: e.folio, m }); s.json({ folio: e.folio, _id: e._id });
}));
api.post('/egresos/:id/autorizar', auth, only(...TES), wrap(async (q, s) => {
  const e = await Egreso.findById(q.params.id); if (!e || e.estatus !== 'Solicitado') throw bad('Esta solicitud ya fue resuelta', 404);
  if (String(e.solicitadoPor) === String(q.user._id) && q.user.role !== 'admin') throw bad('No puedes autorizar un gasto que tú solicitaste', 403);
  if (q.body.aprobar) {
    const [st] = await estadoPresupuesto(e.department), libre = ['admin', 'presidente'].includes(q.user.role);
    if (!libre && !(st.presupuesto > 0)) throw bad('Define primero el presupuesto de este departamento');
    if (!libre && e.monto > st.disponible) throw bad(`Excede el presupuesto disponible ($${st.disponible}). Solo el presidente puede autorizar un sobregiro.`);
    e.estatus = 'Autorizado';
  } else { if (!q.body.motivo) throw bad('Indica el motivo del rechazo'); e.estatus = 'Rechazado'; e.motivo = String(q.body.motivo).slice(0, 300); }
  e.autorizadoPor = q.user._id; await e.save(); await notify([e.solicitadoPor], `${e.folio}: ${e.estatus}${e.motivo ? ' · ' + e.motivo : ''}`); audit(q.user, 'egreso_autorizar', { folio: e.folio, estatus: e.estatus }); s.json({ ok: 1 });
}));
api.post('/egresos/:id/pagar', auth, only(...PAGA), wrap(async (q, s) => {
  const e = await Egreso.findById(q.params.id); if (!e || e.estatus !== 'Autorizado') throw bad('Solo se pagan gastos autorizados', 404);
  if (String(e.autorizadoPor) === String(q.user._id) && q.user.role !== 'admin') throw bad('Quien autoriza no puede registrar el pago: pídelo a Caja', 403);
  const { referencia, comprobante } = q.body; if (String(referencia || '').trim().length < 4) throw bad('Captura la referencia o clave de rastreo del pago');
  if (comprobante && !/^data:(image|application\/pdf)/.test(comprobante)) throw bad('El comprobante debe ser imagen o PDF');
  Object.assign(e, { estatus: 'Pagado', referenciaPago: String(referencia).trim(), comprobantePago: comprobante, pagadoPor: q.user._id, pagadoEn: new Date() }); await e.save();
  await notify([e.solicitadoPor], `${e.folio}: gasto pagado`); audit(q.user, 'egreso_pagar', { folio: e.folio }); s.json({ ok: 1 });
}));
api.get('/presupuesto', auth, only('admin', 'presidente', 'tesorero', 'caja', 'director'), wrap(async (q, s) => s.json({ anio: anioAct(), departamentos: await estadoPresupuesto(q.user.role === 'director' ? q.user.department : null) })));
api.post('/presupuesto', auth, only(...TES), wrap(async (q, s) => {
  if (!(await Department.exists({ _id: q.body.department })) || !(+q.body.monto >= 0)) throw bad('Datos no válidos');
  const p = await Presupuesto.findOneAndUpdate({ anio: +q.body.anio || anioAct(), department: q.body.department }, { monto: +q.body.monto }, { upsert: true, new: true }); audit(q.user, 'presupuesto', { monto: p.monto }); s.json(p);
}));
api.get('/tesoreria/resumen', auth, only('admin', 'presidente', 'tesorero', 'caja'), wrap(async (q, s) => {
  const [pagos, egs, ps] = await Promise.all([Payment.find().select('monto createdAt').lean(), Egreso.find().select('-soporte -comprobantePago').lean(), estadoPresupuesto(null)]);
  const suma = a => a.reduce((t, x) => t + x.monto, 0), anio = anioAct(), pag = egs.filter(e => e.estatus === 'Pagado'), meses = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); const k = d.toISOString().slice(0, 7); meses.push({ mes: k, ingresos: suma(pagos.filter(p => p.createdAt.toISOString().slice(0, 7) === k)), egresos: suma(pag.filter(e => e.pagadoEn && e.pagadoEn.toISOString().slice(0, 7) === k)) }); }
  const rub = {}; egs.filter(e => ['Autorizado', 'Pagado'].includes(e.estatus) && new Date(e.fecha).getFullYear() === anio).forEach(e => rub[e.rubro] = (rub[e.rubro] || 0) + e.monto);
  const sol = egs.filter(e => e.estatus === 'Solicitado');
  s.json({ anio, ingresos: suma(pagos), egresosPagados: suma(pag), porPagar: suma(egs.filter(e => e.estatus === 'Autorizado')), balance: suma(pagos) - suma(pag), solicitudes: { n: sol.length, monto: suma(sol) }, meses, porRubro: Object.entries(rub).map(([nombre, monto]) => ({ nombre, monto })).sort((a, b) => b.monto - a.monto), presupuesto: ps });
}));
const MULTA_DESC = +process.env.DESCUENTO_PRONTO_PAGO || 0, MULTA_DIAS = +process.env.DIAS_PRONTO_PAGO || 5, normId = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const umaVal = async () => (await Ajuste.findOne({ clave: 'uma' }))?.valor || 0;
const enDescuento = m => m.estatus === 'Pendiente' && MULTA_DESC > 0 && (Date.now() - m.createdAt) / 864e5 <= MULTA_DIAS;
const montoMulta = m => enDescuento(m) ? Math.round(m.monto * (100 - MULTA_DESC)) / 100 : m.monto;
const vistaMulta = m => ({ _id: m._id, folio: m.folio, infraccion: m.infraccionNombre, reglamento: m.reglamento, articulo: m.articulo, sujeto: m.sujeto, placa: m.identificador, identificador: m.identificador, lugar: m.lugar, fecha: m.createdAt, umas: m.umas, valorUma: m.valorUma, medida: m.medida, monto: m.monto, montoActual: montoMulta(m), conDescuentoHasta: enDescuento(m) ? new Date(+m.createdAt + MULTA_DIAS * 864e5) : null, estatus: m.estatus });
const MEDIDAS = ['Ninguna', 'Apercibimiento', 'Clausura temporal', 'Suspensión de obra', 'Retiro o decomiso', 'Retención de vehículo'];
const INFRACCIONES = [
  ['Bando de Policía y Gobierno', 'Alterar el orden público'], ['Bando de Policía y Gobierno', 'Consumo de alcohol en la vía pública'], ['Bando de Policía y Gobierno', 'Música o ruido excesivo'], ['Bando de Policía y Gobierno', 'Daños a bienes públicos o pintas (grafiti)'], ['Bando de Policía y Gobierno', 'Faltas a la moral en la vía pública'],
  ['Reglamento de Comercio', 'Operar sin licencia de funcionamiento'], ['Reglamento de Comercio', 'Ocupar la vía pública sin permiso'], ['Reglamento de Comercio', 'Exceder el horario autorizado'], ['Reglamento de Comercio', 'Venta de alcohol a menores'], ['Reglamento de Comercio', 'No exhibir la licencia o permiso'], ['Reglamento de Comercio', 'Anuncios sin autorización'],
  ['Reglamento de Construcciones', 'Construir sin licencia'], ['Reglamento de Construcciones', 'Invadir la vía pública con materiales o escombro'], ['Reglamento de Construcciones', 'Obra sin letrero de licencia visible'], ['Reglamento de Construcciones', 'Ocupar la banqueta con obra'],
  ['Reglamento de Ecología y Limpia', 'Tirar basura en la vía pública'], ['Reglamento de Ecología y Limpia', 'Quema de residuos'], ['Reglamento de Ecología y Limpia', 'Descargar aguas residuales en la calle'], ['Reglamento de Ecología y Limpia', 'Tala o maltrato de áreas verdes sin permiso'], ['Reglamento de Ecología y Limpia', 'Terreno baldío sin limpieza'],
  ['Reglamento de Tránsito', 'Estacionarse en lugar prohibido'], ['Reglamento de Tránsito', 'Exceso de velocidad'], ['Reglamento de Tránsito', 'No respetar el semáforo en rojo'], ['Reglamento de Tránsito', 'Conducir sin licencia'], ['Reglamento de Tránsito', 'Circular sin placas o tarjeta de circulación'], ['Reglamento de Tránsito', 'Uso del celular al conducir'], ['Reglamento de Tránsito', 'Obstruir rampa o cochera'],
  ['Reglamento de Agua Potable', 'Toma clandestina o conexión irregular'], ['Reglamento de Agua Potable', 'Desperdicio de agua'], ['Reglamento de Agua Potable', 'Alterar el medidor'],
  ['Reglamento de Protección Civil', 'Evento sin visto bueno de Protección Civil'], ['Reglamento de Protección Civil', 'Establecimiento sin extintores o salidas de emergencia']
];
api.get('/ajustes/uma', auth, only('admin', 'presidente', 'tesorero', 'caja', 'director', 'agente'), wrap(async (q, s) => s.json({ valor: await umaVal() })));
api.post('/ajustes/uma', auth, only(...TES), wrap(async (q, s) => { const v = +q.body.valor; if (!(v > 0)) throw bad('Captura el valor vigente de la UMA'); await Ajuste.findOneAndUpdate({ clave: 'uma' }, { valor: v }, { upsert: true }); audit(q.user, 'uma', { v }); s.json({ valor: v }); }));
api.get('/infracciones', auth, only('admin', 'presidente', 'tesorero', 'director', 'agente', 'caja'), wrap(async (q, s) => s.json(await Infraccion.find(q.user.role === 'agente' ? { activo: true } : {}).sort('reglamento categoria descripcion'))));
api.post('/infracciones', auth, only(...TES), wrap(async (q, s) => {
  const b = q.body; if (!b.descripcion) throw bad('Falta la descripción');
  s.json(await Infraccion.create({ reglamento: b.reglamento || b.categoria || 'Otro reglamento', categoria: b.reglamento || b.categoria, articulo: b.articulo, descripcion: b.descripcion, monto: Math.max(0, +b.monto || 0), umaMin: Math.max(0, +b.umaMin || 0), umaMax: Math.max(0, +b.umaMax || 0), fundamento: b.fundamento }));
}));
api.put('/infracciones/:id', auth, only(...TES), wrap(async (q, s) => {
  const i = await Infraccion.findById(q.params.id); if (!i) throw bad('No encontrada', 404);
  ['reglamento', 'articulo', 'descripcion', 'fundamento', 'activo'].forEach(k => q.body[k] !== undefined && (i[k] = q.body[k])); ['monto', 'umaMin', 'umaMax'].forEach(k => q.body[k] !== undefined && (i[k] = Math.max(0, +q.body[k] || 0)));
  if (i.umaMax > 0 && i.umaMax < i.umaMin) throw bad('El máximo de UMAs no puede ser menor al mínimo'); await i.save(); audit(q.user, 'infraccion', { id: i._id }); s.json(i);
}));
api.post('/infracciones/plantillas', auth, only(...TES), wrap(async (q, s) => {
  let creadas = 0; for (const [reglamento, descripcion] of INFRACCIONES) { const ex = await Infraccion.findOne({ descripcion }); if (ex) { if (!ex.reglamento) { ex.reglamento = reglamento; await ex.save(); } continue; } await Infraccion.create({ reglamento, categoria: reglamento, descripcion }); creadas++; }
  s.json({ creadas });
}));
api.post('/multas', auth, only('admin', 'presidente', 'agente'), wrap(async (q, s) => {
  const b = q.body, inf = await Infraccion.findById(b.infraccion), id = normId(b.identificador || b.placa), nombre = String(b.infractor || '').trim();
  if (!inf || !inf.activo) throw bad('Elige una infracción del catálogo');
  if (id.length < 4 && nombre.length < 3) throw bad('Captura la placa, licencia o clave del infractor, o al menos su nombre');
  if (b.foto && !/^data:image\//.test(b.foto)) throw bad('La foto debe ser una imagen');
  let umas, valor = 0, monto = inf.monto;
  if (inf.umaMin > 0) {
    valor = await umaVal(); if (!(valor > 0)) throw bad('Tesorería debe definir primero el valor vigente de la UMA');
    umas = +b.umas || inf.umaMin; const max = inf.umaMax > 0 ? inf.umaMax : inf.umaMin; if (umas < inf.umaMin || umas > max) throw bad(`Las UMAs deben estar entre ${inf.umaMin} y ${max}`);
    monto = Math.round(umas * valor * 100) / 100;
  }
  if (!(monto > 0)) throw bad('Esta infracción no tiene sanción definida: pídelo a Tesorería');
  const rein = id.length >= 4 ? await Multa.countDocuments({ identificador: id, infraccion: inf._id, estatus: { $ne: 'Cancelada' } }) : 0;
  const y = new Date().getFullYear(), n = await Counter.findByIdAndUpdate('multa-' + y, { $inc: { n: 1 } }, { upsert: true, new: true });
  const m = await Multa.create({ folio: `MUL-${y}-${String(n.n).padStart(6, '0')}`, infraccion: inf._id, infraccionNombre: inf.descripcion, fundamento: inf.fundamento, reglamento: inf.reglamento || inf.categoria, articulo: inf.articulo, sujeto: ['persona', 'establecimiento', 'vehiculo', 'predio'].includes(b.sujeto) ? b.sujeto : (b.placa ? 'vehiculo' : 'persona'), identificador: id, placa: id, infractor: nombre.slice(0, 100), lugar: String(b.lugar || '').slice(0, 200), observaciones: String(b.observaciones || '').slice(0, 400), medida: MEDIDAS.includes(b.medida) ? b.medida : 'Ninguna', acta: String(b.acta || '').slice(0, 40), foto: b.foto, umas, valorUma: valor || undefined, reincidencias: rein, monto, agente: q.user._id });
  audit(q.user, 'multa', { folio: m.folio, monto: m.monto }); s.json(vistaMulta(m));
}));
api.get('/multas', auth, only('admin', 'presidente', 'tesorero', 'caja', 'agente'), wrap(async (q, s) => {
  const l = await Multa.find(q.user.role === 'agente' ? { agente: q.user._id } : {}).select('-foto').sort('-createdAt').limit(300).populate('agente', 'nombre');
  s.json(l.map(m => ({ ...vistaMulta(m), agente: m.agente?.nombre, infractor: m.infractor, acta: m.acta, reincidencias: m.reincidencias, inconformidad: m.inconformidad })));
}));
api.use('/multas/consulta', rateLimit({ windowMs: 60 * 1000, max: 30 }));
api.get('/multas/consulta', wrap(async (q, s) => {
  const ref = String(q.query.ref || q.query.folio || q.query.placa || '').trim(), f = /^MUL-/i.test(ref) ? { folio: ref.toUpperCase() } : normId(ref).length >= 4 ? { identificador: normId(ref) } : null; if (!f) throw bad('Escribe tu folio, placa, número de licencia o clave catastral');
  s.json((await Multa.find({ ...f, estatus: { $ne: 'Cancelada' } }).select('-foto').sort('-createdAt').limit(30)).map(vistaMulta));
}));
api.post('/multas/:id/pagar', auth, only('ciudadano'), wrap(async (q, s) => {
  const m = await Multa.findById(q.params.id); if (!m || m.estatus !== 'Pendiente') throw bad('Esta multa no se puede pagar en línea', 400);
  const prev = await Case.findOne({ multa: m._id, ciudadano: q.user._id, estatus: 'Pago pendiente' });
  if (prev) { prev.costo = montoMulta(m); await prev.save(); return s.json({ id: prev._id, folio: prev.folio }); }
  const dep = await Department.findOne({ nombre: /tesorer/i });
  const f = await Case.create({ folio: await nextFolio('tramite'), tipo: 'tramite', ciudadano: q.user._id, department: dep?._id, multa: m._id, titulo: `Pago de multa ${m.folio}`, descripcion: `${m.infraccionNombre}${m.reglamento ? ' · ' + m.reglamento : ''}`, costo: montoMulta(m), estatus: 'Pago pendiente', slaVence: new Date(Date.now() + 5 * 864e5), historial: [{ estatus: 'Pago pendiente', por: q.user._id, nota: 'Creado desde Multas' }] });
  s.json({ id: f._id, folio: f.folio });
}));
api.post('/multas/:id/inconformidad', auth, only('ciudadano'), wrap(async (q, s) => {
  const m = await Multa.findById(q.params.id), b = q.body;
  const ok = m && (m.identificador ? normId(b.identificador || b.placa) === m.identificador : m.infractor && String(b.nombre || '').trim().toLowerCase() === m.infractor.toLowerCase());
  if (!m || m.estatus !== 'Pendiente' || !ok) throw bad('No se puede registrar la inconformidad con esos datos');
  if (String(b.motivo || '').trim().length < 10) throw bad('Explica con más detalle tu inconformidad');
  m.estatus = 'En inconformidad'; m.inconformidad = { motivo: String(b.motivo).slice(0, 500), fecha: new Date() }; await m.save();
  await Case.updateMany({ multa: m._id, estatus: 'Pago pendiente' }, { estatus: 'Cancelado' });
  await notify((await User.find({ role: 'tesorero', activo: true })).map(u => u._id), `Inconformidad en la multa ${m.folio}`); s.json({ ok: 1 });
}));
api.post('/multas/:id/resolver', auth, only(...TES), wrap(async (q, s) => {
  const m = await Multa.findById(q.params.id), r = q.body.resolucion; if (!m || !['Pendiente', 'En inconformidad'].includes(m.estatus)) throw bad('Esta multa ya no admite cambios', 404);
  if (!['cancelar', 'reducir', 'confirmar'].includes(r)) throw bad('Elige una resolución'); if (r === 'cancelar' && !q.body.nota) throw bad('Indica el motivo de la cancelación');
  if (r === 'reducir') { const n = +q.body.monto; if (!(n > 0 && n < m.monto)) throw bad('El nuevo monto debe ser menor al actual'); m.monto = n; }
  m.estatus = r === 'cancelar' ? 'Cancelada' : 'Pendiente'; if (r === 'cancelar') m.motivoCancelacion = String(q.body.nota).slice(0, 300);
  m.inconformidad = { ...(m.inconformidad?.toObject?.() || {}), resolucion: r, nota: String(q.body.nota || '').slice(0, 300) }; await m.save();
  if (r !== 'confirmar') await Case.updateMany({ multa: m._id, estatus: { $in: ['Pago pendiente', 'Pago en revisión'] } }, { estatus: 'Cancelado' });
  audit(q.user, 'multa_resolver', { folio: m.folio, r }); s.json({ ok: 1 });
}));
api.get('/verificar/:folio', wrap(async (q, s) => {
  const c = await Case.findOne({ folio: q.params.folio }).select('folio tipo titulo estatus createdAt'); c ? s.json(c) : s.status(404).json({ error: 'Folio no encontrado' });
}));

// --- Dashboard (mismo alcance jerárquico que la lista de casos)
api.get('/stats', auth, only(...STAFF), wrap(async (q, s) => {
  const f = scope(q.user), now = new Date();
  const cs = await Case.find(f).select('estatus department asignadoA slaVence createdAt cerradoEn calificacion').lean();
  const abierto = c => !FINAL.includes(c.estatus), venc = c => abierto(c) && c.slaVence && c.slaVence < now;
  const D = Object.fromEntries((await Department.find()).map(d => [String(d._id), d.nombre])), U = Object.fromEntries((await User.find({ role: { $ne: 'ciudadano' } })).map(u => [String(u._id), u.nombre]));
  const grupo = (key, nombres, vacio) => { const m = new Map(); for (const c of cs) { const k = String(c[key] ?? ''); const g = m.get(k) || { nombre: (nombres && nombres[k]) || (k || vacio || k), n: 0, abiertos: 0, vencidos: 0 }; g.n++; if (abierto(c)) g.abiertos++; if (venc(c)) g.vencidos++; m.set(k, g); } return [...m.values()]; };
  const cerr = cs.filter(c => c.cerradoEn), horas = cerr.length ? cerr.reduce((a, c) => a + (c.cerradoEn - c.createdAt) / 36e5, 0) / cerr.length : 0;
  const sat = new Map(); for (const c of cs.filter(x => x.calificacion > 0)) { const k = String(c.department ?? ''), g = sat.get(k) || { nombre: D[k] || '—', t: 0, n: 0 }; g.t += c.calificacion; g.n++; sat.set(k, g); }
  const pagos = ['admin', 'presidente', 'director'].includes(q.user.role) ? await Payment.find(q.user.role === 'director' ? { department: q.user.department } : {}).select('monto').lean() : [];
  const pend = { sinAsignar: cs.filter(c => abierto(c) && !c.asignadoA).length, precios: await Procedure.countDocuments({ 'costoPendiente.monto': { $exists: true }, ...(TOP.includes(q.user.role) ? {} : { department: q.user.department }) }) };
  s.json({
    total: cs.length, vencidos: cs.filter(venc).length, pendientes: pend, recaudado: pagos.reduce((a, p) => a + (p.monto || 0), 0),
    satisfaccion: [...sat.values()].map(g => ({ nombre: g.nombre, prom: Math.round(g.t / g.n * 10) / 10, n: g.n })), horasPromedio: Math.round(horas),
    porEstatus: grupo('estatus').map(x => ({ nombre: x.nombre, n: x.n })), porDepartamento: grupo('department', D, 'Sin clasificar'), porPersona: grupo('asignadoA', U, 'Sin asignar')
  });
}));

// --- Notificaciones y mensajería interna
api.get('/notifications', auth, wrap(async (q, s) => s.json(await Notification.find({ user: q.user._id }).sort('-createdAt').limit(30))));
api.post('/notifications/leer', auth, wrap(async (q, s) => { await Notification.updateMany({ user: q.user._id }, { leida: true }); s.json({ ok: 1 }); }));
const contactable = u => TOP.includes(u.role) ? {} : { $or: [{ department: u.department }, { role: { $in: TOP } }] };
api.get('/contactos', auth, only(...STAFF), wrap(async (q, s) => s.json(await User.find({ role: { $ne: 'ciudadano' }, activo: true, _id: { $ne: q.user._id }, ...contactable(q.user) }).select('nombre role'))));
const canalOk = async (u, c) => {
  if (c === 'circular') return true;
  if (c.startsWith('dm:')) {
    const ids = c.slice(3).split('_'); if (!ids.includes(String(u._id))) return false;
    const otro = ids.find(i => i !== String(u._id)); if (!otro) return true;
    try { return !!(await User.exists({ _id: otro, role: { $ne: 'ciudadano' }, ...contactable(u) })); } catch { return false; }
  }
  return c.startsWith('dept:') && (TOP.includes(u.role) || c.slice(5) === String(u.department));
};
api.get('/mensajes', auth, only(...STAFF), wrap(async (q, s) => {
  const canal = q.query.canal || ''; if (!(await canalOk(q.user, canal))) throw bad('Canal no permitido', 403);
  s.json((await Message.find({ canal }).sort('-createdAt').limit(100).populate('de', 'nombre')).reverse());
}));
api.post('/mensajes', auth, only(...STAFF), wrap(async (q, s) => {
  const { canal = '', texto } = q.body; if (!texto || !(await canalOk(q.user, canal))) throw bad('Mensaje no válido', 403);
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
  server.listen(process.env.PORT || 3000, () => console.log(SIN_CLAVE ? '⚠ MODO DE PRUEBA: se puede entrar sin contraseña. No lo uses con datos reales.' : 'Oficina Virtual en línea'));
  setInterval(() => { escalar().catch(console.error); recordar().catch(console.error); }, 10 * 60 * 1000);
}).catch(e => { console.error('Error de MongoDB:', e.message); process.exit(1); });

import { supabase } from '../supabase.js';

// ─── CLIENTES ───────────────────────────────────────────
export async function fetchClients() {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      *,
      client_phones(*),
      client_emails(*),
      client_addresses(*),
      client_comments(*),
      client_saved_points(*)
    `)
    .order('id');
  if (error) throw error;
  return data.map(mapClient);
}

export async function updateClient(id, fields) {
  const { error } = await supabase
    .from('clients')
    .update(fields)
    .eq('id', id);
  if (error) throw error;
}

export async function insertSavedPoints(clientId, points, maintYear, savedBy, note) {
  // Los puntos guardados vencen el 31 dic del año siguiente al actual
  const expiryYear = new Date().getFullYear() + 1;
  const expiryDate = new Date(expiryYear, 11, 31).toISOString().split("T")[0];
  const { data, error } = await supabase
    .from('client_saved_points')
    .insert([{
      client_id: clientId,
      points: points,
      expiry_date: expiryDate,
      maint_year: maintYear || null,
      saved_at: new Date().toISOString(),
      note: note || null,
    }])
    .select().single();
  if (error) throw error;
  return data;
}

function mapClient(c) {
  return {
    id: c.id,
    contractNo: c.contract_no,
    name: c.full_name,
    contractDate: c.contract_date,
    contractYears: c.contract_years,
    yearsElapsed: c.years_elapsed,
    totalPoints: c.total_points,
    pointsUsedToDate: c.points_used_to_date,
    annualPoints: c.annual_points,
    paidPoints: c.paid_points,
    balance: parseFloat(c.balance_usd || 0),
    dueDate: c.due_date,
    status: c.account_status,
    contractStatus: c.contract_status,
    cancelDate: c.cancel_date,
    cancelReason: c.cancel_reason,
    assignedGestor: c.assigned_gestor_id ? String(c.assigned_gestor_id) : null,
    savedPoints: (c.client_saved_points || []).map(sp => ({
      id: sp.id, points: sp.points,
      expiryDate: sp.expiry_date,
      maintYear: sp.maint_year,
      note: sp.note,
    })),
    phones: (c.client_phones || []).map(p => ({ id: p.id, label: p.label, number: p.phone, active: p.is_active !== false })),
    emails: (c.client_emails || []).map(e => ({ id: e.id, label: e.label, email: e.email, active: e.is_active !== false })),
    addresses: (c.client_addresses || []).map(a => ({ id: a.id, label: a.label, address: a.address, text: a.address, active: a.is_active !== false })),
    comments: (c.client_comments || []).map(cm => ({
      id: cm.id,
      text: cm.body || '',
      body: cm.body || '',
      author: cm.author_id ? String(cm.author_id) : '',
      date: cm.created_at?.slice(0, 10)
    })),
  };
}

// ─── PAGOS ───────────────────────────────────────────────
export async function fetchPayments() {
  const { data, error } = await supabase
    .from('payments')
    .select('*, clients(full_name, contract_no), processedUser:users!processed_by(username, full_name), originatedUser:users!originated_by(username, full_name)')
    .eq('is_deleted', false)
    .order('payment_date', { ascending: false });
  if (error) throw error;
  return data.map(mapPayment);
}

export async function insertPayment(p) {
  console.log('insertPayment payload:', JSON.stringify(p, null, 2));
  const { data, error } = await supabase
    .from('payments')
    .insert([p])
    .select()
    .single();
  if (error) {
    console.error('insertPayment error:', error);
    throw error;
  }
  console.log('insertPayment success:', data);
  return data;
}

function mapPayment(p) {
  return {
    id: p.id,
    clientId: p.client_id,
    clientName: p.clients?.full_name,
    contractNo: p.clients?.contract_no,
    date: p.payment_date,
    amount: parseFloat(p.total_mxn || 0),
    amountMant: parseFloat(p.maint_amount_usd || 0),
    amountMora: parseFloat(p.mora_amount_usd || 0),
    discountMant: parseFloat(p.maint_discount_usd || 0),
    discountMora: parseFloat(p.mora_discount_usd || 0),
    points: p.points_credited || 0,
    type: p.concept,
    note: p.note,
    status: 'Liquidado',
    processedBy: p.processedUser?.username || null, // username del cajero que valido
    originatedBy: p.originatedUser?.username || null, // username del gestor que propuso
    methodId: p.payment_method_id,
    method: null, // se resuelve en cliente con pms
    maintYear: p.maint_year,
    maintPointExpiry: p.maint_point_expiry,
    isPrepago: p.is_prepago,
    fxRate: p.fx_rate_id,
  };
}

// ─── RESERVACIONES ────────────────────────────────────────
export async function fetchReservations() {
  const { data, error } = await supabase
    .from('reservations')
    .select('*, clients(full_name, contract_no), units(name)')
    .order('check_in', { ascending: false });
  if (error) throw error;
  return data.map(r => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.clients?.full_name,
    contractNo: r.clients?.contract_no,
    unitId: r.unit_id,
    unitName: r.units?.name,
    season: r.season,
    checkIn: r.check_in,
    checkOut: r.check_out,
    nights: r.nights,
    pointsUsed: r.points_used,
    status: r.status,
    processedBy: r.processed_by,
    createdAt: r.created_at,
  }));
}

export async function insertReservation(r) {
  const { data, error } = await supabase
    .from('reservations')
    .insert([r])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── UNIDADES ─────────────────────────────────────────────
export async function fetchUnits() {
  const { data, error } = await supabase
    .from('units')
    .select('*, unit_season_ranges(*)')
    .order('id');
  if (error) throw error;
  return data.map(u => ({
    id: u.id,
    name: u.name,
    typeId: u.unit_type_id,
    location: u.location || '',
    active: u.is_active !== false,
    occ: [],
    seasons: u.unit_season_ranges || [],
  }));
}

export async function insertUnit(u) {
  const { data, error } = await supabase
    .from('units')
    .insert([{
      name: u.name,
      unit_type_id: u.typeId,
      location: u.location || '',
      is_active: u.active !== false,
    }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateUnit(id, fields) {
  const dbFields = {};
  if (fields.name !== undefined) dbFields.name = fields.name;
  if (fields.typeId !== undefined) dbFields.unit_type_id = fields.typeId;
  if (fields.location !== undefined) dbFields.location = fields.location;
  if (fields.active !== undefined) dbFields.is_active = fields.active;
  const { error } = await supabase
    .from('units')
    .update(dbFields)
    .eq('id', id);
  if (error) throw error;
}

export async function fetchUnitTypes() {
  const { data, error } = await supabase
    .from('unit_types')
    .select('*')
    .order('id');
  if (error) return [];
  return data.map(t => ({ id: t.id, name: t.name }));
}

export async function insertUnitType(name) {
  const { data, error } = await supabase
    .from('unit_types')
    .insert([{ name }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateUnitType(id, name) {
  const { error } = await supabase
    .from('unit_types')
    .update({ name })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteUnitType(id) {
  const { error } = await supabase
    .from('unit_types')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─── TIPO DE CAMBIO ───────────────────────────────────────
export async function fetchFxRate() {
  const { data, error } = await supabase
    .from('fx_rates')
    .select('*')
    .order('rate_date', { ascending: false })
    .limit(1)
    .single();
  if (error) return { rate: 17.5, date: new Date().toISOString().split('T')[0] };
  return { id: data.id, rate: parseFloat(data.mxn_per_usd), date: data.rate_date };
}

export async function insertFxRate(rate, setById) {
  const { data, error } = await supabase
    .from('fx_rates')
    .insert([{ mxn_per_usd: rate, rate_date: new Date().toISOString().split('T')[0], set_by: setById }])
    .select().single();
  if (error) throw error;
  return data;
}

// ─── MÉTODOS DE PAGO ──────────────────────────────────────
export async function fetchPaymentMethods() {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('*')
    .order('id');
  if (error) throw error;
  return data.map(m => ({ id: m.id, name: m.name, costPct: parseFloat(m.cost_pct || 0), active: m.is_active !== false }));
}

export async function insertPaymentMethod(pm) {
  const { data, error } = await supabase
    .from('payment_methods')
    .insert([{ name: pm.name, cost_pct: pm.costPct || 0, is_active: pm.active !== false }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updatePaymentMethod(id, fields) {
  const dbFields = {};
  if (fields.name !== undefined) dbFields.name = fields.name;
  if (fields.costPct !== undefined) dbFields.cost_pct = fields.costPct;
  if (fields.active !== undefined) dbFields.is_active = fields.active;
  const { error } = await supabase
    .from('payment_methods')
    .update(dbFields)
    .eq('id', id);
  if (error) throw error;
}

// ─── PROMESAS ─────────────────────────────────────────────
export async function fetchPromises() {
  const { data, error } = await supabase
    .from('promises')
    .select('*, clients(full_name, contract_no), users!gestor_id(username, full_name)')
    .order('promise_date', { ascending: false });
  if (error) throw error;
  return data.map(p => ({
    id: p.id,
    clientId: p.client_id,
    clientName: p.clients?.full_name,
    contractNo: p.clients?.contract_no,
    promiseDate: p.promise_date,
    amount: parseFloat(p.amount_usd || 0),
    note: p.note,
    status: p.status,
    gestorUsername: p.users?.username,
    gestorName: p.users?.full_name,
    createdAt: p.created_at?.slice(0, 10),
  }));
}

export async function insertPromise(pr) {
  const { data, error } = await supabase
    .from('promises')
    .insert([pr])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updatePromise(id, fields) {
  const { error } = await supabase
    .from('promises')
    .update(fields)
    .eq('id', id);
  if (error) throw error;
}

// ─── PENDING PAYMENTS ─────────────────────────────────────
export async function fetchPendingPayments() {
  const { data, error } = await supabase
    .from('pending_payments')
    .select('*, clients(full_name, contract_no), users!submitted_by(username)')
    .eq('status', 'pending')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data.map(p => ({
    id: p.id,
    clientId: p.client_id,
    clientName: p.clients?.full_name,
    contractNo: p.clients?.contract_no,
    ptype: p.concept,
    // Los montos vienen en USD; la app los convierte a MXN al cargar usando fxRate
    mantAmtUsd: parseFloat(p.maint_amount_usd || 0),
    moraAmtUsd: parseFloat(p.mora_amount_usd || 0),
    mantDiscUsd: parseFloat(p.maint_discount_usd || 0),
    moraDiscUsd: parseFloat(p.mora_discount_usd || 0),
    totalUsd: parseFloat(p.total_usd || 0),
    mantAmt: 0, moraAmt: 0, mantDisc: 0, moraDisc: 0, totalACobrar: 0,
    submittedBy: p.users?.username,
    submittedAt: p.submitted_at,
    note: p.note,
    status: 'Por Validar',
    maintYear: p.maint_year,
    maintPointExpiry: p.maint_point_expiry,
    isPrepago: p.is_prepago,
    methodId: p.payment_method_id,
    methodName: null,
  }));
}

export async function insertPendingPayment(pp) {
  const { data, error } = await supabase
    .from('pending_payments')
    .insert([pp])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updatePendingPayment(id, fields) {
  const { error } = await supabase
    .from('pending_payments')
    .update(fields)
    .eq('id', id);
  if (error) throw error;
}

// ─── USUARIOS ─────────────────────────────────────────────
export async function fetchUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, password_hash, role, full_name, color_hex, monthly_salary, is_active')
    .eq('is_active', true)
    .order('id');
  if (error) throw error;
  return data.map(u => ({
    id: u.id,
    username: u.username,
    password: u.password_hash,
    role: u.role,
    name: u.full_name,
    color: u.color_hex,
    salary: parseFloat(u.monthly_salary || 0),
    active: u.is_active,
    commissions: { collection: 0.02 },
  }));
}

export async function updateUser(id, fields) {
  const dbFields = {};
  if (fields.salary !== undefined) dbFields.monthly_salary = fields.salary;
  if (fields.name !== undefined) dbFields.full_name = fields.name;
  if (fields.role !== undefined) dbFields.role = fields.role;
  if (fields.color !== undefined) dbFields.color_hex = fields.color;
  if (fields.active !== undefined) dbFields.is_active = fields.active;
  if (fields.password !== undefined) dbFields.password_hash = fields.password;
  if (fields.username !== undefined) dbFields.username = fields.username;
  const { error } = await supabase
    .from('users')
    .update(dbFields)
    .eq('id', id);
  if (error) throw error;
}

export async function insertUser(u) {
  const { data, error } = await supabase
    .from('users')
    .insert([{
      username: u.username,
      password_hash: u.password || 'admin',
      role: u.role,
      full_name: u.name,
      color_hex: u.color || '#3B82F6',
      monthly_salary: u.salary || 0,
      is_active: u.active !== false,
    }])
    .select().single();
  if (error) throw error;
  return data;
}

// ─── CLIENTES (CRUD nuevo) ────────────────────────────────
export async function insertClient(c) {
  const dbFields = {
    contract_no: c.contractNo,
    full_name: c.name,
    contract_date: c.contractDate || null,
    contract_years: c.contractYears || 10,
    years_elapsed: c.yearsElapsed || 0,
    total_points: c.totalPoints || 0,
    points_used_to_date: c.pointsUsedToDate || 0,
    annual_points: c.annualPoints || 0,
    paid_points: 0,
    balance_usd: 0,
    due_date: c.dueDate || null,
    account_status: c.status || 'Active',
    contract_status: c.contractStatus || 'Active',
    assigned_gestor_id: c.assignedGestor ? +c.assignedGestor : null,
  };
  const { data, error } = await supabase
    .from('clients')
    .insert([dbFields])
    .select().single();
  if (error) throw error;
  return data;
}

// ─── PHONES / EMAILS / ADDRESSES / COMMENTS ────────────────
export async function insertClientPhone(clientId, label, number, isActive = true) {
  const { data, error } = await supabase
    .from('client_phones')
    .insert([{ client_id: clientId, label, phone: number, is_active: isActive }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateClientPhone(id, isActive) {
  const { error } = await supabase
    .from('client_phones')
    .update({ is_active: isActive })
    .eq('id', id);
  if (error) throw error;
}

export async function insertClientEmail(clientId, label, email, isActive = true) {
  const { data, error } = await supabase
    .from('client_emails')
    .insert([{ client_id: clientId, label, email, is_active: isActive }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateClientEmail(id, isActive) {
  const { error } = await supabase
    .from('client_emails')
    .update({ is_active: isActive })
    .eq('id', id);
  if (error) throw error;
}

export async function insertClientAddress(clientId, label, address, isActive = true) {
  const { data, error } = await supabase
    .from('client_addresses')
    .insert([{ client_id: clientId, label, address, is_active: isActive }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateClientAddress(id, isActive) {
  const { error } = await supabase
    .from('client_addresses')
    .update({ is_active: isActive })
    .eq('id', id);
  if (error) throw error;
}

export async function insertClientComment(clientId, body, authorId) {
  const { data, error } = await supabase
    .from('client_comments')
    .insert([{ client_id: clientId, body, author_id: authorId, created_at: new Date().toISOString() }])
    .select().single();
  if (error) throw error;
  return data;
}

// ─── RESERVACIONES (cancelar) ─────────────────────────────
export async function updateReservation(id, fields) {
  const dbFields = {};
  if (fields.status !== undefined) dbFields.status = fields.status;
  if (fields.checkIn !== undefined) dbFields.check_in = fields.checkIn;
  if (fields.checkOut !== undefined) dbFields.check_out = fields.checkOut;
  const { error } = await supabase.from('reservations').update(dbFields).eq('id', id);
  if (error) throw error;
}

// ─── VENTA DE PUNTOS ──────────────────────────────────────
export async function insertPointSale(s, processedBy) {
  const { data, error } = await supabase
    .from('point_sales')
    .insert([{
      client_id: s.clientId,
      sale_type: s.stype,
      points: s.pts,
      extra_years: s.eYr || 0,
      extra_annual: s.eAn || 0,
      total_mxn: s.totalMxn || 0,
      total_usd: s.totalUsd || 0,
      processed_by: processedBy,
      sale_date: new Date().toISOString().split('T')[0],
      status: 'validated',
    }])
    .select().single();
  if (error) throw error;
  return data;
}

// ─── COMMISSION RATES ─────────────────────────────────────
export async function fetchCommissionRates() {
  const { data, error } = await supabase
    .from('commission_rates')
    .select('*')
    .eq('is_active', true)
    .order('concept_id');
  if (error) {
    return [
      { id: 'default-mant', concept: 'maintenance', ratePct: 2.0 },
      { id: 'default-prepago', concept: 'prepago', ratePct: 1.0 },
      { id: 'default-moratorios', concept: 'moratorios', ratePct: 3.0 },
      { id: 'default-sale', concept: 'point_sale', ratePct: 0.0 },
    ];
  }
  return data.map(r => ({ id: r.concept_id, concept: r.concept_id, ratePct: parseFloat(r.rate_pct || 0), label: r.label }));
}

export async function upsertCommissionRate(concept, ratePct) {
  const { data: existing } = await supabase
    .from('commission_rates')
    .select('concept_id')
    .eq('concept_id', concept)
    .single();
  if (existing) {
    const { error } = await supabase
      .from('commission_rates')
      .update({ rate_pct: ratePct, updated_at: new Date().toISOString() })
      .eq('concept_id', concept);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('commission_rates')
      .insert([{ concept_id: concept, label: concept, rate_pct: ratePct, is_active: true }]);
    if (error) throw error;
  }
}

// ─── SYSTEM CONFIG (price per point, reservation commission) ───
export async function fetchSystemConfig() {
  const { data, error } = await supabase
    .from('system_config')
    .select('price_per_point_usd, reservation_commission_usd, season_order')
    .single();
  if (error) return { pricePerPoint: 4.75, reservationFee: 150 };
  return {
    pricePerPoint: parseFloat(data.price_per_point_usd || 4.75),
    reservationFee: parseFloat(data.reservation_commission_usd || 150),
    seasonOrder: data.season_order || null,
  };
}

export async function upsertSystemConfig(key, value) {
  // system_config es una sola fila (id=1), con columnas especificas
  const colMap = {
    price_per_point: 'price_per_point_usd',
    reservation_fee: 'reservation_commission_usd',
  };
  const col = colMap[key];
  if (!col) { console.warn('upsertSystemConfig: columna desconocida', key); return; }
  const { error } = await supabase
    .from('system_config')
    .update({ [col]: value, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw error;
}

// ─── CONTRACT (cancelación / reactivación) ─────────────────
export async function cancelClientContract(clientId, reason, type) {
  // type = 'Cancelado s/pago' | 'Cancelado c/pago' | 'Active'
  const fields = { contract_status: type };
  if (type === 'Active') {
    fields.cancel_date = null;
    fields.cancel_reason = null;
  } else {
    fields.cancel_date = new Date().toISOString().split('T')[0];
    fields.cancel_reason = reason;
  }
  const { error } = await supabase
    .from('clients')
    .update(fields)
    .eq('id', clientId);
  if (error) throw error;
}

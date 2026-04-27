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
    phones: (c.client_phones || []).map(p => ({ label: p.label, number: p.phone })),
    emails: (c.client_emails || []).map(e => ({ label: e.label, email: e.email })),
    addresses: (c.client_addresses || []).map(a => ({ label: a.label, address: a.address })),
    comments: (c.client_comments || []).map(cm => ({
      text: cm.comment_text || cm.comment || cm.note || '',
      author: cm.created_by || cm.author || '',
      date: cm.created_at?.slice(0, 10)
    })),
  };
}

// ─── PAGOS ───────────────────────────────────────────────
export async function fetchPayments() {
  const { data, error } = await supabase
    .from('payments')
    .select('*, clients(full_name, contract_no), users!processed_by(username)')
    .eq('is_deleted', false)
    .order('payment_date', { ascending: false });
  if (error) throw error;
  return data.map(mapPayment);
}

export async function insertPayment(p) {
  const { data, error } = await supabase
    .from('payments')
    .insert([p])
    .select()
    .single();
  if (error) throw error;
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
    processedBy: p.users?.username,
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
    typeId: u.type_id,
    active: u.active,
    occ: [], // se calcula desde reservaciones
    seasons: u.unit_season_ranges || [],
  }));
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
    .eq('is_active', true)
    .order('id');
  if (error) throw error;
  return data.map(m => ({ id: m.id, name: m.name, costPct: parseFloat(m.cost_pct || 0) }));
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
    mantAmt: parseFloat(p.maint_amount_usd || 0),
    moraAmt: parseFloat(p.mora_amount_usd || 0),
    mantDisc: parseFloat(p.maint_discount_usd || 0),
    moraDisc: parseFloat(p.mora_discount_usd || 0),
    totalACobrar: parseFloat(p.total_usd || 0),
    submittedBy: p.users?.username,
    submittedAt: p.submitted_at,
    note: p.note,
    status: 'Por Validar',
    maintYear: p.maint_year,
    maintPointExpiry: p.maint_point_expiry,
    isPrepago: p.is_prepago,
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
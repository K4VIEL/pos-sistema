-- Ejecutar UNA vez en Supabase > SQL Editor ---------------------------------------------

-- 1) Datos fiscales adicionales por local (todos opcionales salvo sri_ambiente)
alter table locales add column if not exists razon_social text;            -- si está vacío se usa "propietario"
alter table locales add column if not exists sri_ambiente text default '1'; -- '1' = pruebas, '2' = producción
alter table locales add column if not exists iva_defecto numeric default 0; -- % de IVA para productos sin IVA propio (0 o 15)
-- precios_incluyen_iva = true: los precios del POS ya traen IVA (el total cobrado = total de la factura)
alter table locales add column if not exists precios_incluyen_iva boolean default true;
alter table locales add column if not exists contribuyente_especial text;
alter table locales add column if not exists rimpe boolean default false;
alter table locales add column if not exists agente_retencion text;
alter table locales add column if not exists dir_matriz text;

-- 2) Campos del comprobante en ventas
alter table ventas add column if not exists numero_comprobante text;
alter table ventas add column if not exists numero_autorizacion text;
alter table ventas add column if not exists fecha_autorizacion text;
alter table ventas add column if not exists clave_acceso text;

-- 3) IVA por producto (opcional; si no se llena se usa locales.iva_defecto)
alter table productos add column if not exists iva numeric;

-- 4) Secuenciales: un contador por local / establecimiento / punto de emisión / ambiente / tipo
create table if not exists secuenciales (
  local_id text not null, estab text not null, pto_emi text not null, ambiente text not null, cod_doc text not null,
  ultimo integer not null default 0,
  primary key (local_id, estab, pto_emi, ambiente, cod_doc)
);
create or replace function siguiente_secuencial(p_local_id text, p_estab text, p_pto_emi text, p_ambiente text, p_cod_doc text)
returns integer language plpgsql as $$
declare v integer;
begin
  insert into secuenciales (local_id, estab, pto_emi, ambiente, cod_doc, ultimo)
  values (p_local_id, p_estab, p_pto_emi, p_ambiente, p_cod_doc, 1)
  on conflict (local_id, estab, pto_emi, ambiente, cod_doc)
  do update set ultimo = secuenciales.ultimo + 1
  returning ultimo into v;
  return v;
end $$;

-- 5) Comprobantes (XML firmado/autorizado + datos del RIDE). Tabla aparte para no engordar "ventas".
create table if not exists comprobantes_sri (
  id bigint generated always as identity primary key,
  venta_id text not null unique,
  local_id text not null,
  clave_acceso text not null unique,
  ambiente text not null, estab text not null, pto_emi text not null, secuencial text not null,
  estado text not null default 'PENDIENTE',   -- PENDIENTE | EN_PROCESO | DEVUELTA | AUTORIZADO | NO_AUTORIZADO
  numero_autorizacion text, fecha_autorizacion text,
  xml_firmado text, xml_autorizado text,
  ride_json jsonb, mensajes jsonb,
  creado_en timestamptz default now()
);

-- 6) Seguridad: solo el servidor (service_role) debe tocar estas tablas.
alter table secuenciales enable row level security;
alter table comprobantes_sri enable row level security;
-- (sin políticas = ni la anon key ni el navegador pueden leerlas; service_role las ignora y sí puede)

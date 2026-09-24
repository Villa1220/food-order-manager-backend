-- ============================================================================
-- Sistema Inteligente de Gestion de Pedidos - Restaurante Perucho
-- Esquema de base de datos (PostgreSQL 16+)
--
-- Principios de diseno (requisito explicito del proyecto: "todo debe ser
-- auditable con altos estandares de programacion"):
--   1. Ningun borrado fisico en entidades de negocio (usuarios, platos):
--      se usa soft delete (deleted_at) para no romper el historico de
--      pedidos/pagos ya emitidos.
--   2. Toda tabla mutable tiene created_at/updated_at (updated_at se
--      mantiene solo, via trigger).
--   3. Toda operacion de negocio relevante queda en una tabla de eventos
--      de dominio (order_events, payment_events) con el actor que la hizo.
--   4. Ademas del registro de eventos de dominio, existe una bitacora
--      generica (audit_log) alimentada por triggers a nivel de fila sobre
--      las tablas sensibles: es una segunda linea de defensa que registra
--      TODO cambio aunque exista un bug en la capa de aplicacion.
--   5. Los precios de los pedidos se guardan "congelados" (snapshot) en
--      order_items: si el precio de un plato cambia despues, los pedidos
--      historicos no se alteran.
--   6. Los codigos de pedido y numeros de recibo se generan de forma
--      atomica en la base de datos (secuencias + trigger), evitando
--      condiciones de carrera cuando el canal presencial y el canal
--      WhatsApp crean pedidos al mismo tiempo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Tipos enumerados
-- ----------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'mesero', 'cliente');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- admin/mesero se autentican SOLO con Google (Sign in with Google);
-- cliente se autentica SOLO con OTP por WhatsApp. No existe login con
-- contrasena local en este sistema.
DO $$ BEGIN
    CREATE TYPE auth_provider AS ENUM ('google', 'whatsapp_otp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE order_channel AS ENUM ('presencial', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE order_status AS ENUM
        ('recibido', 'en_preparacion', 'listo', 'entregado', 'cancelado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE demand_band AS ENUM ('pico', 'baja');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE order_item_status AS ENUM ('pendiente', 'listo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_method AS ENUM
        ('efectivo', 'tarjeta', 'transferencia', 'otro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('activo', 'anulado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE audit_action AS ENUM ('INSERT', 'UPDATE', 'DELETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ----------------------------------------------------------------------------
-- 1. Usuarios (admin, mesero, cliente en una sola tabla con rol)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role               user_role NOT NULL,
    full_name          VARCHAR(150) NOT NULL,
    email              VARCHAR(150) UNIQUE,           -- obligatorio para admin/mesero (login con Google)
    phone              VARCHAR(20) UNIQUE NOT NULL,    -- login (OTP) del cliente; contacto de admin/mesero
    auth_provider      auth_provider NOT NULL,
    google_sub          VARCHAR(255) UNIQUE,            -- "sub" del ID token de Google; se llena en el primer login exitoso
    google_linked_at    TIMESTAMPTZ,                     -- cuando el admin/mesero activo su cuenta con Google por primera vez
    phone_verified_at  TIMESTAMPTZ,                     -- se llena cuando el cliente verifica su OTP
    active             BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by         UUID REFERENCES users(id),
    deleted_at         TIMESTAMPTZ,                     -- soft delete

    -- Cliente: solo OTP por WhatsApp, nunca Google, no requiere email.
    -- Admin/mesero: solo Google, requieren email (es la clave de invitacion
    -- que el admin usa al crear la cuenta desde el CRUD de meseros); el
    -- admin los "invita" creando la fila con email y google_sub en NULL,
    -- y queda activada quel primer dia que esa persona entra con Google
    -- y el correo coincide.
    CONSTRAINT chk_auth_provider_by_role CHECK (
        (role = 'cliente'  AND auth_provider = 'whatsapp_otp' AND google_sub IS NULL) OR
        (role <> 'cliente' AND auth_provider = 'google' AND email IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Codigos de un solo uso para el login por telefono (OTP via WhatsApp).
CREATE TABLE IF NOT EXISTS otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    phone       VARCHAR(20) NOT NULL,
    code_hash   TEXT NOT NULL,
    purpose     VARCHAR(20) NOT NULL DEFAULT 'login',
    attempts    INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone, expires_at);

-- Bitacora de accesos (exitosos y fallidos) - auditoria de seguridad.
CREATE TABLE IF NOT EXISTS login_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id),
    phone       VARCHAR(20),
    method      VARCHAR(20) NOT NULL, -- 'google' | 'otp'
    success     BOOLEAN NOT NULL,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_events_user_id ON login_events(user_id);


-- ----------------------------------------------------------------------------
-- 2. Menu (categorias y platos)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS menu_categories (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(80) UNIQUE NOT NULL,
    display_order  INT NOT NULL DEFAULT 0,
    active         BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
    id            SERIAL PRIMARY KEY,
    category_id   INT REFERENCES menu_categories(id),
    name          VARCHAR(120) NOT NULL,
    description   TEXT,
    price         NUMERIC(8,2) NOT NULL CHECK (price >= 0),
    available     BOOLEAN NOT NULL DEFAULT true, -- para marcar "agotado" temporalmente
    image_url     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID REFERENCES users(id),
    updated_by    UUID REFERENCES users(id),
    deleted_at    TIMESTAMPTZ -- soft delete: nunca se borra un plato que ya fue pedido
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id) WHERE deleted_at IS NULL;


-- ----------------------------------------------------------------------------
-- 3. Pedidos
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
    id                  SERIAL PRIMARY KEY,
    order_code          VARCHAR(20) UNIQUE, -- se autogenera en trigger si viene NULL
    channel             order_channel NOT NULL DEFAULT 'presencial',
    table_number        VARCHAR(10),
    mesero_id           UUID REFERENCES users(id),   -- mesero que toma/gestiona el pedido
    customer_id         UUID REFERENCES users(id),   -- se vincula cuando el cliente hace login (mismo telefono)
    customer_phone      VARCHAR(20),                 -- telefono crudo del canal (WhatsApp) para matching
    customer_note       TEXT,
    status              order_status NOT NULL DEFAULT 'recibido',
    demand_band         demand_band,                 -- franja horaria (pico/baja), clasificada automaticamente
    has_error           BOOLEAN NOT NULL DEFAULT false,
    error_description   TEXT,
    corrections_count   INT NOT NULL DEFAULT 0,
    subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0, -- se recalcula solo via trigger sobre order_items

    -- Marcas de tiempo por etapa: alimentan directamente las metricas de la tesis
    -- (tiempo de ciclo, latencia de notificacion al KDS, trazabilidad completa).
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    kitchen_notified_at TIMESTAMPTZ,
    preparing_at        TIMESTAMPTZ,
    ready_at            TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    cancelled_at         TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID REFERENCES users(id) -- NULL si el pedido lo creo el bot/n8n
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_received_at ON orders(received_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_mesero_id ON orders(mesero_id);

CREATE TABLE IF NOT EXISTS order_items (
    id            SERIAL PRIMARY KEY,
    order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id  INT REFERENCES menu_items(id), -- puede quedar NULL si el plato se borra despues; el nombre queda igual
    item_name     VARCHAR(120) NOT NULL,          -- snapshot del nombre al momento del pedido
    unit_price    NUMERIC(8,2) NOT NULL,           -- snapshot del precio al momento del pedido
    quantity      INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes         TEXT,
    status        order_item_status NOT NULL DEFAULT 'pendiente',
    ready_count   INT NOT NULL DEFAULT 0 CHECK (ready_count >= 0 AND ready_count <= quantity),
    ready_at      TIMESTAMPTZ, -- se detiene cuando todas las unidades del plato están marcadas
    line_total    NUMERIC(10,2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Bitacora funcional de cada pedido: respalda la trazabilidad completa
-- exigida por el Anexo D del proyecto (identificador, hora de recepcion,
-- detalle de productos, registro de comanda, visualizacion en cocina,
-- estado final), ahora con el actor (usuario) que genero cada evento.
CREATE TABLE IF NOT EXISTS order_events (
    id            BIGSERIAL PRIMARY KEY,
    order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    event_type    VARCHAR(30) NOT NULL, -- created | kitchen_notified | status_changed | item_edited | error_flagged | correction
    from_status   VARCHAR(20),
    to_status     VARCHAR(20),
    actor_user_id UUID REFERENCES users(id), -- NULL si el evento lo genero el bot/n8n
    metadata      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);


-- ----------------------------------------------------------------------------
-- 4. Pagos (multiples/parciales por pedido - cuenta dividida)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
    id              SERIAL PRIMARY KEY,
    order_id        INT NOT NULL REFERENCES orders(id),
    receipt_number  VARCHAR(20) UNIQUE, -- se autogenera en trigger si viene NULL (REC-000123)
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    payment_method  payment_method NOT NULL,
    status          payment_status NOT NULL DEFAULT 'activo',
    processed_by    UUID NOT NULL REFERENCES users(id), -- mesero o admin que cobra
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at       TIMESTAMPTZ,
    void_reason     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);

-- Plato y cantidad que entraron en cada cuenta. El precio ya incluye IVA.
CREATE TABLE IF NOT EXISTS payment_lines (
    id             SERIAL PRIMARY KEY,
    payment_id     INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    order_item_id  INT NOT NULL REFERENCES order_items(id),
    item_name      VARCHAR(120) NOT NULL,
    quantity       INT NOT NULL CHECK (quantity > 0),
    unit_price     NUMERIC(8,2) NOT NULL,
    line_total     NUMERIC(10,2) GENERATED ALWAYS AS (unit_price * quantity) STORED
);

CREATE INDEX IF NOT EXISTS idx_payment_lines_payment_id ON payment_lines(payment_id);

-- Auditoria especifica de pagos: quien edito un monto, cuando y por que.
CREATE TABLE IF NOT EXISTS payment_events (
    id            BIGSERIAL PRIMARY KEY,
    payment_id    INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    event_type    VARCHAR(30) NOT NULL, -- created | amount_edited | method_changed | voided
    actor_user_id UUID REFERENCES users(id),
    old_values    JSONB,
    new_values    JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id);

-- Vista de saldo por pedido: total del pedido, pagado y saldo pendiente,
-- considerando solo pagos activos (no anulados). Util para "CRUD de pago
-- de pedidos" (saber si un pedido esta pagado, parcial o pendiente).
CREATE OR REPLACE VIEW order_balances AS
SELECT
    o.id AS order_id,
    o.subtotal AS total,
    COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'activo'), 0) AS paid_total,
    o.subtotal - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'activo'), 0) AS balance_due
FROM orders o
LEFT JOIN payments p ON p.order_id = o.id
GROUP BY o.id, o.subtotal;


-- ----------------------------------------------------------------------------
-- 5. Bitacora generica de auditoria (defensa en profundidad)
-- ----------------------------------------------------------------------------
-- Ademas de order_events/payment_events (eventos de negocio legibles),
-- audit_log registra el antes/despues crudo de CUALQUIER fila modificada
-- en las tablas sensibles, alimentada por trigger - no depende de que la
-- capa de aplicacion recuerde llamarla.

CREATE TABLE IF NOT EXISTS audit_log (
    id             BIGSERIAL PRIMARY KEY,
    table_name     TEXT NOT NULL,
    record_id      TEXT NOT NULL,
    action         audit_action NOT NULL,
    actor_user_id  UUID,
    old_data       JSONB,
    new_data       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);


-- ----------------------------------------------------------------------------
-- 6. Funciones y triggers
-- ----------------------------------------------------------------------------

-- 6.1 updated_at automatico en cualquier UPDATE.
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['users','menu_categories','menu_items','orders','order_items','payments'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s;
             CREATE TRIGGER trg_%1$s_updated_at
             BEFORE UPDATE ON %1$s
             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();', t
        );
    END LOOP;
END $$;

-- 6.2 Generacion atomica de order_code (PED-YYMMDD-00001).
CREATE SEQUENCE IF NOT EXISTS order_code_seq;

CREATE OR REPLACE FUNCTION fn_set_order_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.order_code IS NULL THEN
        NEW.order_code := 'PED-' || to_char(now(), 'YYMMDD') || '-' ||
                           lpad(nextval('order_code_seq')::text, 5, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_set_code ON orders;
CREATE TRIGGER trg_orders_set_code
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION fn_set_order_code();

-- 6.3 Generacion atomica de receipt_number (REC-000123).
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq;

CREATE OR REPLACE FUNCTION fn_set_receipt_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.receipt_number IS NULL THEN
        NEW.receipt_number := 'REC-' || lpad(nextval('receipt_number_seq')::text, 6, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_set_receipt ON payments;
CREATE TRIGGER trg_payments_set_receipt
BEFORE INSERT ON payments
FOR EACH ROW EXECUTE FUNCTION fn_set_receipt_number();

-- 6.4 Recalculo automatico de orders.subtotal cuando cambian order_items.
CREATE OR REPLACE FUNCTION fn_recalc_order_subtotal()
RETURNS TRIGGER AS $$
DECLARE affected_order_id INT;
BEGIN
    affected_order_id := COALESCE(NEW.order_id, OLD.order_id);
    UPDATE orders
    SET subtotal = COALESCE((
        SELECT SUM(line_total) FROM order_items WHERE order_id = affected_order_id
    ), 0)
    WHERE id = affected_order_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_items_recalc ON order_items;
CREATE TRIGGER trg_order_items_recalc
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION fn_recalc_order_subtotal();

-- 6.5 Auditoria generica por fila (audit_log).
-- El actor se toma de una variable de sesion que la API debe fijar al
-- iniciar cada transaccion: SELECT set_config('app.current_user_id', $1, true);
-- Si no se fija (p. ej. procesos del sistema/bot), queda NULL.
CREATE OR REPLACE FUNCTION fn_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE actor UUID;
BEGIN
    BEGIN
        actor := NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    EXCEPTION WHEN OTHERS THEN
        actor := NULL;
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log(table_name, record_id, action, actor_user_id, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'INSERT', actor, NULL, row_to_json(NEW)::jsonb);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log(table_name, record_id, action, actor_user_id, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'UPDATE', actor, row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log(table_name, record_id, action, actor_user_id, old_data, new_data)
        VALUES (TG_TABLE_NAME, OLD.id::text, 'DELETE', actor, row_to_json(OLD)::jsonb, NULL);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['users','menu_items','orders','order_items','payments'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_audit ON %1$s;
             CREATE TRIGGER trg_%1$s_audit
             AFTER INSERT OR UPDATE OR DELETE ON %1$s
             FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();', t
        );
    END LOOP;
END $$;

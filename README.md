# food-order-manager-backend

API del Sistema Inteligente de Gestión de Pedidos (La Ruta del Sabor).

**Stack detectado en esta máquina:** Node `v22.22.2`, npm `10.9.7`.  
**Base de datos:** PostgreSQL 16 en Docker (`rutadelsabor-db`).

## Requisitos

1. Docker Desktop con el contenedor de Postgres en marcha:

```powershell
docker start rutadelsabor-db
docker ps
```

2. Node 22+ (`node -v`).

## Arranque local

```powershell
cd C:\Users\andre\OneDrive\Documentos\food-order-manager-backend
Copy-Item .env.example .env   # si aún no existe .env
npm install
npm run dev
```

- Health: http://localhost:4000/health  
- Pedidos: http://localhost:4000/api/orders  
- Google: `POST /api/auth/google` con `{ "credential": "<id_token>" }` — responde nombre, correo y rol.

En `.env` define `GOOGLE_CLIENT_ID` (el mismo que `NEXT_PUBLIC_GOOGLE_CLIENT_ID` del frontend). El primer inicio de sesión con Google crea al **admin** (nombre + correo). Los siguientes correos deben estar invitados.

Conexión por defecto:

`postgresql://admin:admin123@localhost:5432/rutadelsaborDB`

El esquema ya está aplicado dentro del contenedor (`schema.sql` en el init de Docker). Una copia vive en `src/db/schema.sql` para el repositorio.

## Scripts

- `npm run dev` — recarga con `tsx watch`
- `npm run typecheck` — TypeScript sin emitir
- `npm run build` / `npm start` — producción

// authMiddleware.js
import dotenv from "dotenv";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

dotenv.config();

// Este cliente usa la ANON KEY, igual que el frontend,
// y solo se usa para validar el JWT que manda el usuario.
const supabaseAuth = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware: requiere usuario logueado en Supabase
export async function requireSupabaseUser(req, res, next) {
  try {
    // 1) Leer header Authorization
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (!token) {
      console.error("❌ Falta Authorization en la request. Headers:", req.headers);
      return res.status(401).json({
        error: "Falta token de Supabase (Authorization: Bearer ...)",
      });
    }

    // 2) Validar el token con Supabase
    const {
      data: { user },
      error,
    } = await supabaseAuth.auth.getUser(token);

    if (error) {
      console.error("❌ Error validando token en Supabase:", error);
      return res.status(401).json({ error: "Token de Supabase inválido" });
    }

    if (!user) {
      console.error("❌ Supabase no devolvió usuario para ese token");
      return res.status(401).json({ error: "Usuario no válido" });
    }

    // 3) Guardamos el usuario en la request y seguimos
    req.supabaseUser = user;
    next();
  } catch (err) {
    console.error("❌ Error en requireSupabaseUser:", err);
    res.status(500).json({ error: "Error validando autenticación" });
  }
}



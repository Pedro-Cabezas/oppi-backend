// authMiddleware.js
// Middleware para validar el usuario de Supabase usando el token JWT que manda el frontend

import dotenv from "dotenv";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

dotenv.config();

const supabaseAdmin = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ ÚNICA definición de requireSupabaseUser
export async function requireSupabaseUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [, token] = authHeader.split(" ");

    if (!token) {
      return res.status(401).json({ error: "Falta token de Supabase (Authorization: Bearer ...)" });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      console.error("Error getUser Supabase:", error);
      return res.status(401).json({ error: "Token de Supabase inválido" });
    }

    // Guardamos el usuario en la request
    req.supabaseUser = data.user;
    next();
  } catch (err) {
    console.error("❌ Error en requireSupabaseUser:", err);
    return res.status(500).json({ error: "Error validando el usuario" });
  }
}


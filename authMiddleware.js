// authMiddleware.js
import { supabaseAdmin } from "./supabaseAdmin.js";

export async function requireSupabaseUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Falta header Authorization" });
    }

    const [, token] = authHeader.split(" ");
    if (!token) {
      return res.status(401).json({ error: "Token no encontrado" });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      console.error("Error getUser:", error);
      return res.status(401).json({ error: "Token inválido" });
    }

    // Usuario de Supabase disponible en la request
    req.supabaseUser = data.user;

    next();
  } catch (e) {
    console.error("Error en requireSupabaseUser:", e);
    return res.status(500).json({ error: "Error interno de autenticación" });
  }
}

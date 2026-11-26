// Modo ensayo: con CORREO_PRUEBA=alguien@firma.cr TODO lo que la Oficina enviaría (reclamos, recordatorios de
// cobro, resumen de Hacienda, enlaces de acceso, el reporte diario) va a ese buzón, con el destinatario original
// en el asunto. Así se prueba Comunicación y Cartera de punta a punta sin tocar a un cliente. Vacío = envío real.
export const modoEnsayo = cfg => String(cfg?.CORREO_PRUEBA || "").trim() || null;
export function desviar(cfg, para, asunto) {
  const ensayo = modoEnsayo(cfg);
  if (!ensayo) return { para, asunto, desviado: null };
  return { para: ensayo, asunto: `[ENSAYO · iba a ${para || "(sin destinatario)"}] ${asunto}`, desviado: para || null };
}

// Envio opcional. Sin SMTP configurado el reporte solo se guarda en ./reportes.
export async function enviar({ cfg, asunto, html, texto, log }) {
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS) {
    log("SMTP sin configurar — no se envia correo (el reporte quedo en ./reportes).");
    return { enviado: false, motivo: "SMTP sin configurar" };
  }
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch { log("Falta nodemailer. Corra: npm install"); return { enviado: false, motivo: "falta nodemailer" }; }

  const port = Number(cfg.SMTP_PORT || 465);
  const tr = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port, secure: port === 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS }
  });
  const d = desviar(cfg, cfg.REPORTE_PARA, asunto);
  const info = await tr.sendMail({
    from: cfg.REPORTE_DE || cfg.SMTP_USER,
    to: d.para, subject: d.asunto, text: texto, html
  });
  log("Correo enviado a " + d.para + (d.desviado ? " (ensayo; iba a " + d.desviado + ")" : "") + " (" + info.messageId + ")");
  return { enviado: true, id: info.messageId, desviado: d.desviado };
}

// Un correo cualquiera (los avisos de Victor aprobados). Falla con error si no hay SMTP.
// Con transporte inyectable (las pruebas pasan uno falso); en modo ensayo se desvía antes de enviar.
export async function enviarCorreo({ cfg, para, asunto, html, texto, responderA = null, transporte = null }) {
  if (!transporte && (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS)) throw new Error("SMTP sin configurar");
  const d = desviar(cfg, para, asunto);
  let tr = transporte;
  if (!tr) {
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(cfg.SMTP_PORT || 465);
    tr = nodemailer.createTransport({ host: cfg.SMTP_HOST, port, secure: port === 465, auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } });
  }
  const info = await tr.sendMail({ from: cfg.REPORTE_DE || cfg.SMTP_USER, to: d.para, subject: d.asunto, html, text: texto, ...(responderA ? { replyTo: responderA } : {}) });
  return { id: info.messageId, para: d.para, desviado: d.desviado };
}

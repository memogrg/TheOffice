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
  const info = await tr.sendMail({
    from: cfg.REPORTE_DE || cfg.SMTP_USER,
    to: cfg.REPORTE_PARA, subject: asunto, text: texto, html
  });
  log("Correo enviado a " + cfg.REPORTE_PARA + " (" + info.messageId + ")");
  return { enviado: true, id: info.messageId };
}

// Un correo cualquiera (los avisos de Victor aprobados). Falla con error si no hay SMTP.
export async function enviarCorreo({ cfg, para, asunto, html, texto, responderA = null }) {
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS) throw new Error("SMTP sin configurar");
  const nodemailer = (await import("nodemailer")).default;
  const port = Number(cfg.SMTP_PORT || 465);
  const tr = nodemailer.createTransport({ host: cfg.SMTP_HOST, port, secure: port === 465, auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } });
  const info = await tr.sendMail({ from: cfg.REPORTE_DE || cfg.SMTP_USER, to: para, subject: asunto, html, text: texto, ...(responderA ? { replyTo: responderA } : {}) });
  return { id: info.messageId };
}

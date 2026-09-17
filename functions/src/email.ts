/**
 * email.ts
 * --------
 * Skickar mail via Gmail SMTP med nodemailer. Enklaste möjliga vägen
 * inom nuvarande uppsättning — ingen ny extern tjänst, inget nytt
 * konto att skapa: bara ett Gmail-konto (kan vara ett Kenny redan har)
 * och ett app-lösenord.
 *
 * Uppgifterna lagras i Firebase Secret Manager (redan en del av
 * Firebase-projektet, ALDRIG i Firestore eller kod). Sätts EN gång
 * via CLI, se README-instruktionen i handoffReminders.ts.
 */

import { defineSecret } from "firebase-functions/params";
import type nodemailerType from "nodemailer";

export const GMAIL_USER = defineSecret("GMAIL_USER");
export const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

let cachedTransporter: ReturnType<typeof nodemailerType.createTransport> | null = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require("nodemailer") as typeof nodemailerType;
  cachedTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER.value(),
      pass: GMAIL_APP_PASSWORD.value(),
    },
  });
  return cachedTransporter;
}

/**
 * Skickar ett enkelt textmail. Kastar ALDRIG — ett misslyckat mail ska
 * inte få hela påminnelse-jobbet (som skickar till flera föräldrar och
 * barn i en enda körning) att stanna av. Fel loggas bara.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `Varannan <${GMAIL_USER.value()}>`,
      to,
      subject,
      text: body,
    });
  } catch (err) {
    console.error(`[email] Kunde inte skicka till ${to}:`, err);
  }
}

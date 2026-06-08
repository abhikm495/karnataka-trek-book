/**
 * CAPTCHA is generated client-side on the login page (not by the server).
 * See generate() in debug-login.html — we replicate that logic here.
 */
const CAPTCHA_CHARS =
  "0123456789qwertyuiopasdfghjkzxcvbnmQWERTYUOPASDFGHJKLZXCVBNM";

export function generateCaptcha(): string {
  let value = "";

  for (let i = 1; i < 6; i++) {
    value += CAPTCHA_CHARS.charAt(
      Math.floor(Math.random() * CAPTCHA_CHARS.length),
    );
  }

  return value;
}

/*
 * phone-format.js
 * ------------------------------------------------------------------
 * Shared US phone number formatting used by the registration form and
 * anywhere else a phone field is collected. Example: 3053391756 -> (305) 339-1756
 * ------------------------------------------------------------------
 */
function formatPhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
  const len = digits.length;
  if (len === 0) return '';
  if (len < 4) return `(${digits}`;
  if (len < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Attaches live formatting to a text input as the user types, keeping
// the caret at the end (safe for phone numbers, which are typed left-to-right).
function attachPhoneFormatting(inputEl) {
  if (!inputEl) return;
  inputEl.setAttribute('inputmode', 'tel');
  inputEl.addEventListener('input', () => {
    inputEl.value = formatPhoneNumber(inputEl.value);
  });
}

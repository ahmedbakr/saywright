/**
 * What a control or an address looks like it does, when what it does can't be taken back: deleting, paying, sending
 * or signing out. Autopilot leaves these alone unless the person allows them (see the studio's shared/autopilot.ts),
 * and the page itself refuses the requests and navigations they lead to while Autopilot acts (bridge/guard.ts).
 *
 * Words are matched as whole words, in the languages the studio is used in. A control that is only an icon is judged
 * by its icon and classes; a link by where it goes; a submit button by its form's address and method.
 */

/** Whole words (and phrases) that say a control deletes, pays, sends or signs out. */
const WORDS = [
  // English: deleting and taking away
  'delete', 'deletes', 'delete all', 'remove', 'remove all', 'erase', 'destroy', 'wipe', 'purge', 'clear all', 'clear data', 'clear history', 'clear everything',
  'empty trash', 'empty the trash', 'empty bin', 'empty the bin', 'empty cart', 'empty basket', 'factory reset', 'reset all', 'reset everything', 'reset account', 'reset data',
  'revoke', 'terminate', 'drop table', 'drop database', 'uninstall', 'deactivate', 'disable account', 'close account', 'close my account', 'ban', 'kick', 'leave team', 'leave group', 'leave organization', 'leave organisation', 'leave workspace',
  'unsubscribe', 'refund', 'void',
  // English: paying
  'pay', 'pay now', 'submit payment', 'complete payment', 'make a payment', 'confirm payment', 'purchase', 'complete purchase', 'buy', 'buy now', 'order now',
  'place order', 'place the order', 'place my order', 'place your order', 'confirm order', 'confirm purchase', 'complete order', 'donate', 'subscribe', 'upgrade now', 'charge', 'transfer', 'withdraw', 'checkout now',
  // English: sending
  'send', 'resend', 'send all', 'email', 'email all', 'notify', 'invite', 'publish', 'broadcast', 'deploy', 'post',
  // English: signing out
  'log out', 'logout', 'log off', 'logoff', 'sign out', 'signout', 'sign off',
  // Arabic
  'حذف', 'احذف', 'إزالة', 'ازالة', 'أزل', 'مسح', 'امسح', 'مسح الكل', 'إفراغ', 'تعطيل', 'تعطيل الحساب', 'إغلاق الحساب', 'إلغاء الطلب', 'إلغاء الاشتراك', 'إلغاء الحجز',
  'ادفع', 'دفع', 'ادفع الآن', 'إتمام الدفع', 'إتمام الطلب', 'إتمام الشراء', 'تأكيد الطلب', 'تأكيد الدفع', 'تأكيد الشراء', 'اطلب الآن', 'اشتر', 'اشتري', 'شراء', 'اشترك', 'تبرع',
  'إرسال', 'ارسال', 'أرسل', 'ارسل', 'نشر', 'انشر', 'تحويل', 'سحب', 'تسجيل الخروج', 'خروج',
  // French
  'supprimer', 'supprimer tout', 'effacer', 'retirer', 'vider', 'désactiver', 'résilier', 'se désabonner', 'désabonner', 'annuler la commande', 'annuler l’abonnement', "annuler l'abonnement",
  'payer', 'valider le paiement', 'acheter', 'commander', 'valider la commande', 'envoyer', 'publier', 'se déconnecter', 'déconnexion',
  // Spanish
  'eliminar', 'borrar', 'quitar', 'vaciar', 'desactivar', 'darse de baja', 'cancelar pedido', 'cancelar el pedido', 'cancelar suscripción', 'cancelar la suscripción',
  'pagar', 'comprar', 'realizar pedido', 'finalizar compra', 'enviar', 'publicar', 'cerrar sesión', 'salir',
  // German
  'löschen', 'alle löschen', 'entfernen', 'leeren', 'deaktivieren', 'kündigen', 'stornieren', 'abbestellen', 'bezahlen', 'zahlen', 'jetzt bezahlen', 'kaufen', 'jetzt kaufen',
  'bestellen', 'zahlungspflichtig bestellen', 'senden', 'absenden', 'versenden', 'veröffentlichen', 'abmelden', 'ausloggen',
  // Portuguese
  'excluir', 'apagar', 'remover', 'esvaziar', 'desativar', 'cancelar assinatura', 'cancelar a assinatura', 'finalizar pagamento', 'finalizar pedido', 'finalizar compra', 'publicar', 'sair', 'terminar sessão', 'encerrar sessão',
  // Italian
  'elimina', 'eliminare', 'cancella', 'rimuovi', 'svuota', 'disattiva', 'annulla ordine', 'annulla l’ordine', "annulla l'ordine", 'disiscriviti', 'paga', 'pagare', 'paga ora', 'acquista', 'compra', 'ordina ora', 'invia', 'pubblica', 'esci', 'disconnetti',
  // Turkish
  'sil', 'tümünü sil', 'kaldır', 'temizle', 'boşalt', 'devre dışı bırak', 'hesabı kapat', 'aboneliği iptal et', 'siparişi iptal et', 'abonelikten çık', 'öde', 'ödeme yap', 'şimdi öde',
  'satın al', 'sipariş ver', 'siparişi tamamla', 'gönder', 'yayınla', 'çıkış yap', 'çıkış', 'oturumu kapat',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+').replace(/['’]/g, "['’]");
/** "Cancel order", "Cancel my subscription": cancelling alone is the safe answer in a dialog; cancelling a thing is not. */
const CANCEL_THING = String.raw`cancel\s+(?:my\s+|the\s+|this\s+|your\s+|all\s+)?(?:orders?|subscriptions?|plans?|bookings?|reservations?|memberships?|accounts?|payments?|transfers?|appointments?|trips?|flights?)`;
const RISKY_WORDS = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[CANCEL_THING, ...WORDS.sort((a, b) => b.length - a.length).map(escape)].join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

/** The words in a control's name, text, label or title that say it can't be taken back, or null. */
export function riskyWords(text: string): string | null {
  return RISKY_WORDS.exec(text.normalize('NFC'))?.[0] ?? null;
}

/** Icon names and class words that mean danger: `trash`, `fa-trash`, `lucide-trash-2`, `btn-danger`, `destructive`. */
const RISKY_TOKENS = new Set(['trash', 'delete', 'remove', 'destroy', 'erase', 'bin', 'wipe', 'purge', 'danger', 'destructive', 'logout', 'signout', 'unsubscribe', 'deactivate']);

/** The words of a class list or an icon's id, split where code splits them: `fa-trash`, `TrashIcon`, `icon_delete`. */
export function codeWords(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The first word of an icon or a class list that means danger, or null. */
export function riskyToken(s: string): string | null {
  const words = codeWords(s);
  for (let i = 0; i < words.length; i++) {
    if (RISKY_TOKENS.has(words[i])) return words[i];
    if ((words[i] === 'log' || words[i] === 'sign') && words[i + 1] === 'out') return `${words[i]} out`;
  }
  return null;
}

/** Path words that say a request or a page deletes, pays, sends or signs out: /logout, /account/delete, /api/pay. */
const RISKY_PATH = new Set(['logout', 'logoff', 'signout', 'delete', 'destroy', 'remove', 'cancel', 'unsubscribe', 'deactivate', 'pay', 'charge', 'purchase', 'send', 'erase', 'wipe', 'purge', 'refund']);

/** What in an address says it deletes, pays, sends or signs out (its path, or `_method=delete`), or null. */
export function riskyPath(url: string, base = 'http://localhost/'): string | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const words = codeWords(decodeURIComponent(u.pathname));
  for (let i = 0; i < words.length; i++) {
    if (RISKY_PATH.has(words[i])) return words[i];
    if ((words[i] === 'log' || words[i] === 'sign') && (words[i + 1] === 'out' || words[i + 1] === 'off')) return `${words[i]} ${words[i + 1]}`;
  }
  const method = u.searchParams.get('_method') ?? u.searchParams.get('method');
  if (method && /^delete$/i.test(method)) return 'delete';
  return null;
}

/** A dialog's answers that say no: what is always safe to press in a dialog that asks. */
const DISMISS =
  /^(?:cancel|no|no,? thanks|not now|close|dismiss|keep|keep it|go back|back|never ?mind|stay|إلغاء|الغاء|لا|إغلاق|اغلاق|رجوع|annuler|non|fermer|cancelar|no gracias|cerrar|abbrechen|nein|schließen|não|fechar|annulla|chiudi|iptal|vazgeç|hayır|kapat|×|x|✕)$/iu;

/** Whether a dialog's button only says no (Cancel, Close, Not now): pressing it changes nothing. */
export const dismisses = (name: string): boolean => DISMISS.test(name.trim().replace(/[.!]$/, ''));

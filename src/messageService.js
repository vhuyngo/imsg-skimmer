// Per-message service labels (SMS/MMS/RCS vs iMessage) for UI and export styling.

export function isSmsService(service) {
  return typeof service === 'string' && /^(sms|mms|rcs)$/i.test(service.trim());
}

export function isIMessageService(service) {
  return typeof service === 'string' && /^imessage$/i.test(service.trim());
}

/** CSS class suffix for an outgoing bubble: green SMS, blue iMessage (and unknown non-SMS). */
export function outgoingBubbleClass(fromMe, service) {
  if (!fromMe) return '';
  return isSmsService(service) ? ' sms' : ' imessage';
}

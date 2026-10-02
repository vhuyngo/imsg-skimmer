// Extracts the plain text from a message.attributedBody blob (NSArchiver "streamtyped" NSAttributedString).
const CLASS_NAMES = [Buffer.from('NSString'), Buffer.from('NSMutableString')];
// A new type-encoding string "+" (0x84 tag, length 1): the UTF-8 bytes of the string follow.
const BYTES_TYPE = Buffer.from([0x84, 0x01, 0x2b]);
const INT16 = 0x81;
const INT32 = 0x82;

export function attributedBodyText(blob) {
  if (!blob || !blob.length) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  let start = -1;
  for (const name of CLASS_NAMES) {
    const i = buf.indexOf(name);
    if (i >= 0 && (start < 0 || i + name.length < start)) start = i + name.length;
  }
  if (start < 0) return null;
  const typeAt = buf.indexOf(BYTES_TYPE, start);
  if (typeAt < 0 || typeAt - start > 32) return null;
  let pos = typeAt + BYTES_TYPE.length;
  let len;
  const tag = buf[pos];
  if (tag === INT16 && pos + 3 <= buf.length) {
    len = buf.readUInt16LE(pos + 1);
    pos += 3;
  } else if (tag === INT32 && pos + 5 <= buf.length) {
    len = buf.readUInt32LE(pos + 1);
    pos += 5;
  } else if (tag !== undefined && tag < 0x80) {
    len = tag;
    pos += 1;
  } else {
    return null;
  }
  if (pos + len > buf.length) return null;
  return buf.toString('utf8', pos, pos + len);
}

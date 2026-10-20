import { z } from "zod";
import { fail } from "./failure.js";
import type { EventAttachment } from "./event-model.js";

export const MAX_ATTACHMENTS = 25;

export const attachmentInputSchema = z.union([
  z.string(),
  z.object({
    fileUrl: z.string().optional(),
    fileId: z.string().optional(),
    title: z.string().optional(),
  }),
]).describe("A Google Drive file: its URL (docs.google.com/... or drive.google.com/...), its file id, or {fileUrl|fileId, title?}.");

export const attachmentsDescription = `Google Drive files to attach (at most ${MAX_ATTACHMENTS}). Each item is a Drive URL, a Drive file id, or {fileUrl|fileId, title?}. Google resolves the file; the caller must have access to it.`;

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{4,}$/;

function assertAttachmentCap(count: number): void {
  if (count > MAX_ATTACHMENTS) fail(`An event can hold at most ${MAX_ATTACHMENTS} attachments; this change would leave ${count}.`);
}

function driveIdFromUrl(url: string): string | undefined {
  return url.match(/[?&]id=([A-Za-z0-9_-]+)/)?.[1] ?? url.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1];
}

function driveRef(raw: string): { fileUrl: string; fileId?: string } {
  const ref = raw.trim();
  if (/^https?:\/\//.test(ref)) return { fileUrl: ref, fileId: driveIdFromUrl(ref) };
  if (DRIVE_FILE_ID_RE.test(ref)) return { fileUrl: `https://drive.google.com/open?id=${ref}`, fileId: ref };
  fail(`Attachment "${ref}" is neither a Drive URL nor a Drive file id`);
}

function attachmentKeys(a: { fileUrl: string; fileId?: string }): string[] {
  return [a.fileId, a.fileUrl, driveIdFromUrl(a.fileUrl)].filter((k): k is string => !!k);
}

export function normalizeAttachments(input: AttachmentInput[]): EventAttachment[] {
  assertAttachmentCap(input.length);
  return input.map((a) => {
    const raw = typeof a === "string" ? { fileUrl: a } : a;
    const { fileUrl } = driveRef(raw.fileUrl ?? raw.fileId ?? "");
    return { fileUrl, ...(raw.title && { title: raw.title }) };
  });
}

export function mergeAttachments(existing: EventAttachment[] = [], add: EventAttachment[], remove: string[]): EventAttachment[] {
  const removals = remove.map((r) => ({ ref: r.trim(), keys: new Set(attachmentKeys(driveRef(r))) }));
  const matches = (a: EventAttachment, keys: Set<string>) => attachmentKeys(a).some((k) => keys.has(k));
  const unmatched = removals.filter(({ keys }) => !existing.some((a) => matches(a, keys)));
  if (unmatched.length > 0) {
    fail(`No attachment matches ${unmatched.map((u) => u.ref).join(", ")}, so nothing was changed.`, {
      attachments: existing.map((a) => a.fileId ?? a.fileUrl),
    });
  }
  const kept = existing.filter((a) => !removals.some(({ keys }) => matches(a, keys)));
  const present = new Set(kept.flatMap(attachmentKeys));
  for (const a of add) {
    const keys = attachmentKeys(a);
    if (keys.some((k) => present.has(k))) continue;
    keys.forEach((k) => present.add(k));
    kept.push(a);
  }
  assertAttachmentCap(kept.length);
  return kept;
}

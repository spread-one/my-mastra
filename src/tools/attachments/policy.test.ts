import { describe, expect, it } from 'vitest';
import { attachmentKind, validateAttachmentDownloadMime } from './policy.js';

describe('authorized format vs generic download transport MIME', () => {
  it('never recognizes force-download as a standalone metadata format', () => {
    for (const mime of ['application/force-download', ' Application/Force-Download ; charset=UTF-8 ']) {
      expect(() => attachmentKind(mime)).toThrow('UNSUPPORTED_TYPE');
    }
  });
  it.each(['text', 'csv'] as const)('allows only the narrow transport exception for %s, preserving normalization and UTF8 charset policy', kind => {
    for (const mime of ['application/force-download', ' Application/Force-Download ',
      'APPLICATION/FORCE-DOWNLOAD; CHARSET = "UTF-8"', 'application/force-download; charset=utf8']) {
      expect(() => validateAttachmentDownloadMime(mime, kind)).not.toThrow();
    }
    for (const mime of ['application/force-download; charset=latin1', ' Application/Force-Download ; CHARSET = "UTF-16"']) {
      expect(() => validateAttachmentDownloadMime(mime, kind)).toThrow('INVALID_UTF8');
    }
  });
  it('does not broaden PDF transport or permit HTTP MIME to change the authorized kind', () => {
    expect(() => validateAttachmentDownloadMime('application/force-download', 'pdf')).toThrow('UNSUPPORTED_TYPE');
    expect(() => validateAttachmentDownloadMime('text/plain', 'csv')).toThrow('UNSUPPORTED_TYPE');
    expect(() => validateAttachmentDownloadMime('text/csv', 'text')).toThrow('UNSUPPORTED_TYPE');
    for (const kind of ['text', 'csv', 'pdf'] as const) {
      for (const mime of ['', 'application/octet-stream', 'text/html', 'application/json']) {
        expect(() => validateAttachmentDownloadMime(mime, kind)).toThrow('UNSUPPORTED_TYPE');
      }
    }
  });
  it('preserves matching concrete supported MIME and aliases', () => {
    for (const mime of ['text/plain', ' Text/Markdown ; charset="UTF-8"', 'text/x-markdown']) {
      expect(() => validateAttachmentDownloadMime(mime, 'text')).not.toThrow();
    }
    for (const mime of ['text/csv', ' Application/CSV ; charset=utf8']) {
      expect(() => validateAttachmentDownloadMime(mime, 'csv')).not.toThrow();
    }
    expect(() => validateAttachmentDownloadMime('application/pdf', 'pdf')).not.toThrow();
    expect(() => validateAttachmentDownloadMime('text/csv; charset=iso-8859-1', 'csv')).toThrow('INVALID_UTF8');
  });
});

import { expect, test } from 'bun:test';
import { attachmentContentDisposition } from './download-headers.ts';

test('a Chinese download filename survives response construction and preserves its name', async () => {
  const name = 'rc120_长图_2160px.jpg';
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const response = new Response(bytes, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.length),
      'content-disposition': attachmentContentDisposition(name),
    },
  });
  const disposition = response.headers.get('content-disposition')!;
  expect(disposition).toStartWith('attachment; filename="rc120____2160px.jpg";');
  expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(name);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

test('ASCII names remain compatible and header controls are sanitized', () => {
  expect(attachmentContentDisposition('index.html')).toBe('attachment; filename="index.html"');
  expect(attachmentContentDisposition('bad"name.txt')).toBe('attachment; filename="bad_name.txt"');
  expect(attachmentContentDisposition('bad\r\n\\name.txt')).toBe('attachment; filename="bad___name.txt"');
  const disposition = attachmentContentDisposition("长图 ('final').jpg");
  expect(disposition).toContain("filename*=UTF-8''%E9%95%BF%E5%9B%BE%20%28%27final%27%29.jpg");
  expect(() => new Headers({ 'content-disposition': disposition })).not.toThrow();
});

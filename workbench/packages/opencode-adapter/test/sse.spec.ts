import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventStreamParser } from '../src/index.ts';

const encoder = new TextEncoder();
const feed = (parser: EventStreamParser, text: string) => parser.push(encoder.encode(text));

test('frames are read as they arrive, wherever the chunks cut them', () => {
  const parser = new EventStreamParser();
  const first = 'data: {"id":"evt_1","type":"server.connected","data":{}}\n\n: heartbeat\n\n';
  const second = 'data: {"id":"evt_2","type":"session.created","data":{"id":"ses_x"}}\n\n';
  // One character at a time, as a slow socket would give them.
  const events = [...first, ...second].flatMap(char => feed(parser, char));
  assert.deepEqual(events.map(event => event.type), ['server.connected', 'session.created']);
  assert.equal(parser.pending, false);
});

test('the separators and line endings the server may use are all understood', () => {
  const parser = new EventStreamParser();
  assert.deepEqual(feed(parser, 'data: {"type":"a"}\r\n\r\n').map(event => event.type), ['a']);
  assert.deepEqual(feed(parser, 'data: {"type":"b"}\r\n\r\ndata: {"type":"c"}\n\r\n').map(event => event.type), ['b', 'c']);
  // A line that ends with a carriage return alone.
  assert.deepEqual(feed(parser, 'data: {"type":"r"}\r\r').map(event => event.type), ['r']);
  assert.deepEqual(feed(parser, 'data: {"type":"s"}\r\rdata: {"type":"t"}\r\r').map(event => event.type), ['s', 't']);
  // Two events in one chunk, and a frame made of several data lines.
  const events = feed(parser, 'data: {"type":"d",\ndata:  "x":1}\n\ndata:{"type":"e"}\n\n');
  assert.deepEqual(events, [{ type: 'd', x: 1 }, { type: 'e' }]);
});

test('a frame that is not an event is not an event', () => {
  const parser = new EventStreamParser();
  assert.deepEqual(feed(parser, ': heartbeat\n\n\n\n: another comment\n\nevent: ping\n\n'), []);
  // Text that is not JSON, or not an event, is handed over as unreadable rather than dropped.
  assert.deepEqual(feed(parser, 'data: not json\n\n'), [{ type: 'unparseable', raw: 'not json' }]);
  assert.deepEqual(feed(parser, 'data: {"id":"evt_9"}\n\n'), [{ type: 'unparseable', raw: '{"id":"evt_9"}' }]);
});

test('the end of the stream gives up a frame that never got its empty line, and nothing more', () => {
  const parser = new EventStreamParser();
  feed(parser, 'data: {"type":"a"}\n\ndata: {"type":"b"}');
  assert.equal(parser.pending, true);
  assert.deepEqual(parser.close().map(event => event.type), ['b']);
  assert.deepEqual(parser.close(), []);
  assert.equal(parser.pending, false);
});

test('a character split across two chunks survives', () => {
  const parser = new EventStreamParser();
  const bytes = encoder.encode('data: {"type":"t","text":"中文😀"}\n\n');
  const events = [...parser.push(bytes.subarray(0, 30)), ...parser.push(bytes.subarray(30))];
  assert.deepEqual(events, [{ type: 't', text: '中文😀' }]);
});

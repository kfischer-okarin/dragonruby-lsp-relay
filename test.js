const assert = require('assert');
const fsPromises = require('fs/promises');
const test = require('node:test');
const {
  buildInitializeMessage,
  buildLSPMessage,
  buildRandomMessage,
  buildValidServerResponses,
  closeServerIfNecessary,
  deleteFileIfNecessary,
  fileExists,
  killProcessIfNecessary,
  readFile,
  sendToRelayProcess,
  startRelayProcess,
  startStubServer,
  tryToReadFromStream,
  waitUntilFileHasContent,
  waitUntilReceivedRequestCount,
  waitUntilRelayProcessHasState,
} = require('./testHelpers.js');


let relayProcess;
let server;

test.afterEach(async () => {
  if (relayProcess) {
    await killProcessIfNecessary(relayProcess);
  }
  if (server) {
    await closeServerIfNecessary(server);
  }
});

test.describe('LSP message relay', () => {
  test('Relays LSP requests to server and responses from server', async () => {
    server = await startStubServer([
      { status: 200, body: '{"response": "ok"}' },
    ]);
    relayProcess = await startRelayProcess();

    const response = await sendToRelayProcess(relayProcess,
                                              'Content-Length: 23\r\n' +
                                              '\r\n' +
                                              '{"method":"initialize"}');

    assert.strictEqual(response,
                       'Content-Length: 18\r\n' +
                       '\r\n' +
                       '{"response": "ok"}');
    assert.deepStrictEqual(server.receivedRequests, [
      { method: 'POST', url: '/dragon/lsp', body: '{"method":"initialize"}', contentLength: 23 },
    ]);
  });

  test('Shows no output when server replies with 204', async () => {
    server = await startStubServer([
      ...buildValidServerResponses(1),
      { status: 204, body: '' },
    ]);
    relayProcess = await startRelayProcess();
    await sendToRelayProcess(relayProcess, buildInitializeMessage());

    const response = await sendToRelayProcess(relayProcess, buildRandomMessage());

    assert.strictEqual(response, null);
  });

  test('Ignores messages while no server is started', async () => {
    relayProcess = await startRelayProcess();
    await sendToRelayProcess(relayProcess, buildLSPMessage('{"messageNumber": 1}'));

    server = await startStubServer(buildValidServerResponses(1));
    await sendToRelayProcess(relayProcess, buildLSPMessage('{"messageNumber": 2}'));

    assert.deepStrictEqual(server.receivedRequests, [
      { method: 'POST', url: '/dragon/lsp', body: '{"messageNumber": 2}', contentLength: 20 },
    ]);
  });

  test('Remembers initialize message until server starts', async () => {
    relayProcess = await startRelayProcess();
    await sendToRelayProcess(relayProcess, buildLSPMessage('{"method": "initialize"}'));

    server = await startStubServer([
      { status: 200, body: '{"result": {}}' },
    ]);
    await waitUntilReceivedRequestCount(server, 1);

    assert.deepStrictEqual(server.receivedRequests, [
      { method: 'POST', url: '/dragon/lsp', body: '{"method": "initialize"}', contentLength: 24 },
    ]);
  });

  test('Sends same initialize message again when server restarts', async () => {
    relayProcess = await startRelayProcess();
    server = await startStubServer(buildValidServerResponses(1));
    await sendToRelayProcess(relayProcess, buildLSPMessage('{"method": "initialize"}'));
    await closeServerIfNecessary(server);
    await sendToRelayProcess(relayProcess, buildRandomMessage());
    await waitUntilRelayProcessHasState('reconnectingToServer');

    server = await startStubServer(buildValidServerResponses(1));
    await waitUntilReceivedRequestCount(server, 1);

    assert.deepStrictEqual(server.receivedRequests, [
      { method: 'POST', url: '/dragon/lsp', body: '{"method": "initialize"}', contentLength: 24 },
    ]);
    const response = await tryToReadFromStream(relayProcess.stdout);
    // Don't deliver initialized response again
    assert.strictEqual(response, null);
  });
});

test.describe('Git Ignored data folder', () => {
  test('Creates .lsp-http-relay folder in current directory', async () => {
    relayProcess = await startRelayProcess();

    const dataFolderStats = await fsPromises.stat('.lsp-http-relay');

    assert.ok(dataFolderStats.isDirectory(), '.lsp-http-relay is not a directory');
  });

  test('Directory has a .gitignore file ignoring everything', async () => {
    relayProcess = await startRelayProcess();

    const gitIgnoreContent = await readFile('.lsp-http-relay/.gitignore');

    assert.strictEqual(gitIgnoreContent, '*');
  });
});

test.describe('States', () => {
  const stateFile = '.lsp-http-relay/state';

  test("Enters state 'waitingForEditor' before first message", async () => {
    relayProcess = await startRelayProcess();
    await waitUntilFileHasContent(stateFile, 'waitingForEditor');
  });

  test("Enters state 'connectingToServer' after initialize message", async () => {
    relayProcess = await startRelayProcess();
    await sendToRelayProcess(relayProcess, buildInitializeMessage());
    await waitUntilFileHasContent(stateFile, 'connectingToServer');
  });

  test("Enters state 'connectedToServer' after server responds to initialize message", async () => {
    relayProcess = await startRelayProcess();
    server = await startStubServer(buildValidServerResponses(1));
    await sendToRelayProcess(relayProcess, buildInitializeMessage());
    await waitUntilFileHasContent(stateFile, 'connectedToServer');
  });

  test("Enters state 'reconnectingToServer' after server connection is lost", async () => {
    relayProcess = await startRelayProcess();
    server = await startStubServer(buildValidServerResponses(1));
    await sendToRelayProcess(relayProcess, buildInitializeMessage());
    await closeServerIfNecessary(server);
    await sendToRelayProcess(relayProcess, buildRandomMessage());
    await waitUntilFileHasContent(stateFile, 'reconnectingToServer');
  });

  test('Removes state file after process ends', async () => {
    relayProcess = await startRelayProcess();
    await killProcessIfNecessary(relayProcess);
    const stateFileExists = await fileExists(stateFile);
    assert.strictEqual(stateFileExists, false, 'State file should not exist but does');
  });
});

test.describe('Logging requests', () => {
  test.afterEach(async () => {
    await deleteFileIfNecessary('.lsp-http-relay/session.log');
  });

  test('Logs requests and state changes to session.log when starting with --log', async () => {
    relayProcess = await startRelayProcess('http://localhost:9001/dragon/lsp --log');
    server = await startStubServer([
      { status: 200, body: '{"response": "ok"}' },
    ]);
    await sendToRelayProcess(relayProcess, buildLSPMessage('{"method": "initialize"}'));
    await waitUntilRelayProcessHasState('connectedToServer');

    const logContent = await readFile('.lsp-http-relay/session.log');
    const logLines = logContent.trim().split('\n');

    assert.strictEqual(logLines.length, 5);
    assert.match(logLines[0], /.+ state waitingForEditor/);
    assert.match(logLines[1], /.+ state connectingToServer/);
    assert.match(logLines[2], /.+ request \{"method": "initialize"\}/);
    assert.match(logLines[3], /.+ response \{"response": "ok"\}/);
    assert.match(logLines[4], /.+ state connectedToServer/);
  });

  test('Logs nothing when not starting with --log flag', async () => {
    relayProcess = await startRelayProcess();
    server = await startStubServer(buildValidServerResponses(1));
    await sendToRelayProcess(relayProcess, buildInitializeMessage());

    const logFileExists = await fileExists('output.log');
    assert.strictEqual(logFileExists, false, 'Log file should not exist but does');
  });
});

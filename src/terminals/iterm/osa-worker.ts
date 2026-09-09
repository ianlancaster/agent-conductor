import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * One interpreter per Conductor, not per capture. Each osascript process checks
 * into Launch Services; sustained fleets can otherwise consume over a million
 * application serial numbers and expose macOS's serial-number rollover bug.
 * NSAppleScript instances remain request-local. Only the interpreter is reused.
 * The protocol is ASCII JSON on stdin and UTF-8 JSON on stdout, one line each.
 */
export const OSA_WORKER_SCRIPT = String.raw`
ObjC.import('Foundation');
var input = $.NSFileHandle.fileHandleWithStandardInput;
var output = $.NSFileHandle.fileHandleWithStandardOutput;
var buffer = '';
// Catch inside AppleScript: an uncaught NSAppleScript error can try to address
// the host application's error handler, blocking a nested OSA invocation.
var wrapper = 'on run argv\n' +
  'try\n' +
  'with timeout of 20 seconds\n' +
  'set value to run script (item 1 of argv) with parameters (item 2 of argv)\n' +
  'end timeout\n' +
  'if value is missing value then return {true, ""}\n' +
  'return {true, (value as string) & linefeed}\n' +
  'on error msg number n\n' +
  'return {false, msg & " (" & n & ")"}\n' +
  'end try\nend run';
function reply(value) {
  output.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
while (true) {
  var data = input.availableData;
  if (Number(data.length) === 0) break;
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  var newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    var line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      var request = JSON.parse(line);
      var script = $.NSAppleScript.alloc.initWithSource($(wrapper));
      var event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
        0x61657674, 0x6f617070, $.NSAppleEventDescriptor.nullDescriptor, -1, 0);
      var args = $.NSAppleEventDescriptor.listDescriptor;
      request.args.forEach(function (arg, index) {
        args.insertDescriptorAtIndex($.NSAppleEventDescriptor.descriptorWithString($(arg)), index + 1);
      });
      var parameters = $.NSAppleEventDescriptor.listDescriptor;
      parameters.insertDescriptorAtIndex($.NSAppleEventDescriptor.descriptorWithString($(request.script)), 1);
      parameters.insertDescriptorAtIndex(args, 2);
      event.setParamDescriptorForKeyword(parameters, 0x2d2d2d2d);
      var error = Ref();
      var result = script.executeAppleEventError(event, error);
      var details = ObjC.deepUnwrap(error[0]);
      if (details) {
        reply({error: String(details.NSAppleScriptErrorMessage || 'AppleScript failed') +
          ' (' + String(details.NSAppleScriptErrorNumber) + ')'});
      } else {
        var succeeded = result.descriptorAtIndex(1).booleanValue;
        var value = ObjC.unwrap(result.descriptorAtIndex(2).stringValue);
        if (succeeded) reply({stdout: String(value)});
        else reply({error: String(value)});
      }
    } catch (error) { reply({error: String(error)}); }
  }
}
`;

interface Request {
  script: string;
  args: readonly string[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RunnerOptions {
  spawnWorker?: () => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  cooldownMs?: number;
  maxBufferBytes?: number;
  maxPending?: number;
  maxRequests?: number;
}

/** Internal adapter seam; injectable process creation keeps failure tests off iTerm. */
export class OsaRunner {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private active: Request | undefined;
  private readonly queue: Request[] = [];
  private output = '';
  private outputBytes = 0;
  private stderrBytes = 0;
  private completedRequests = 0;
  private retryAfter = 0;
  private disposed = false;
  private readonly onExit = (): void => this.dispose();

  constructor(private readonly options: RunnerOptions = {}) {
    process.once('exit', this.onExit);
  }

  run(script: string, args: readonly string[] = []): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('AppleScript runner is closed'));
    if (Date.now() < this.retryAfter)
      return Promise.reject(new Error('AppleScript worker is cooling down after failure'));
    if (this.queue.length + (this.active === undefined ? 0 : 1) >= (this.options.maxPending ?? 64)) {
      return Promise.reject(new Error('AppleScript request queue is full'));
    }
    return new Promise((resolve, reject) => {
      const request: Request = {
        script,
        args,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.active === request) {
            this.fail(new Error('AppleScript request timed out; its outcome is unknown and it was not replayed'));
          } else {
            const index = this.queue.indexOf(request);
            if (index !== -1) this.queue.splice(index, 1);
            reject(new Error('AppleScript request expired before execution'));
          }
        }, this.options.timeoutMs ?? 20_000),
      };
      this.queue.push(request);
      this.dispatch();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener('exit', this.onExit);
    this.fail(new Error('AppleScript runner is closed'));
  }

  private dispatch(): void {
    if (this.active !== undefined || this.queue.length === 0) return;
    this.active = this.queue.shift();
    const request = this.active;
    if (request === undefined) return;
    try {
      const worker = this.worker ?? this.start();
      this.setReferenced(worker, true);
      this.stderrBytes = 0;
      // ASCII avoids decoding a multibyte input character across Foundation reads.
      const line = JSON.stringify({ script: request.script, args: request.args }).replace(
        /[^\x20-\x7e]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      worker.stdin.write(`${line}\n`, (error) => {
        if (error !== null && error !== undefined && this.worker === worker) this.fail(error);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    const worker =
      this.options.spawnWorker?.() ?? spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', OSA_WORKER_SCRIPT]);
    this.worker = worker;
    this.completedRequests = 0;
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      if (this.worker !== worker) return;
      this.outputBytes += Buffer.byteLength(chunk);
      if (this.outputBytes > (this.options.maxBufferBytes ?? 10 * 1024 * 1024)) {
        this.fail(new Error('AppleScript response exceeded the output limit'));
        return;
      }
      this.output += chunk;
      const newline = this.output.indexOf('\n');
      if (newline === -1) return;
      const line = this.output.slice(0, newline);
      if (this.output.slice(newline + 1) !== '') {
        this.fail(new Error('AppleScript worker returned unexpected output'));
        return;
      }
      this.output = '';
      this.outputBytes = 0;
      const request = this.active;
      if (request === undefined) {
        this.fail(new Error('AppleScript worker replied without a request'));
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        this.fail(new Error('AppleScript worker returned invalid JSON'));
        return;
      }
      if (
        typeof response !== 'object' ||
        response === null ||
        !(
          ('stdout' in response && typeof response.stdout === 'string') ||
          ('error' in response && typeof response.error === 'string')
        )
      ) {
        this.fail(new Error('AppleScript worker returned an invalid response'));
        return;
      }
      clearTimeout(request.timer);
      this.active = undefined;
      if ('error' in response) request.reject(new Error(String(response.error)));
      else if ('stdout' in response) request.resolve(String(response.stdout));
      this.setReferenced(worker, false);
      // JXA/OSA retain native caches. Recycle only between completed requests
      // to bound their lifetime while reducing process churn by three orders.
      this.completedRequests += 1;
      if (this.completedRequests >= (this.options.maxRequests ?? 1_000)) {
        this.worker = undefined;
        worker.kill('SIGKILL');
      }
      this.dispatch();
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      if (this.worker !== worker) return;
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > (this.options.maxBufferBytes ?? 10 * 1024 * 1024)) {
        this.fail(new Error('AppleScript worker exceeded the stderr limit'));
      }
    });
    const onError = (error: Error): void => {
      if (this.worker === worker) this.fail(error);
    };
    worker.on('error', onError);
    worker.stdin.on('error', onError);
    worker.stdout.on('error', onError);
    worker.stderr.on('error', onError);
    worker.on('close', () => {
      if (this.worker === worker)
        this.fail(new Error('AppleScript worker exited; the active request was not replayed'));
    });
    return worker;
  }

  private setReferenced(worker: ChildProcessWithoutNullStreams, referenced: boolean): void {
    if (referenced) worker.ref();
    else worker.unref();
    for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
      // Child-process pipes are sockets on supported Node versions. Idle pipes
      // must not keep a one-shot CLI alive; active requests retain all handles.
      const handle = stream as typeof stream & { ref?: () => void; unref?: () => void };
      if (referenced) handle.ref?.();
      else handle.unref?.();
    }
  }

  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.output = '';
    this.outputBytes = 0;
    this.retryAfter = Date.now() + (this.options.cooldownMs ?? 20_000);
    // A blocked interpreter must actually die; SIGTERM can remain pending on
    // a stopped macOS process. No request is automatically retried after this.
    worker?.kill('SIGKILL');
    const pending = this.active === undefined ? this.queue.splice(0) : [this.active, ...this.queue.splice(0)];
    this.active = undefined;
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

/*
 * Provides federated streams for handling call arguments
 *
 * InArgStream is for handling incoming arg parts from call frames.  It handles
 * dispatching the arg chunks into .arg{1,2,3} streams.
 *
 * OutArgStream is for creating outgoing arg parts by writing to .arg{1,2,3}
 * streams.  It handles buffering as many parts as are written within one event
 * loop tick into an Array of arg chunks.  Such array is then flushed using
 * setImmediate.
 *
 * Due to the semantic complexity involved here, this code is tested by an
 * accompanying exhaistive search test in test/argstream.js.  This test has
 * both unit tests (disabled by default for speed) and an integration test.
 */

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('stream').PassThrough;
var Ready = require('ready-signal');
var TypedError = require('error/typed');

var ArgChunkOutOfOrderError = TypedError({
    type: 'arg-chunk-out-of-order',
    message: 'out of order arg chunk, current: {current} got: {got}',
    current: null,
    got: null,
    chunk: null
});

function ArgStream() {
    var self = this;
    EventEmitter.call(self);
    self.arg1 = StreamArg();
    self.arg2 = StreamArg();
    self.arg3 = StreamArg();

    self.arg1.on('error', passError);
    self.arg2.on('error', passError);
    self.arg3.on('error', passError);
    function passError(err) {
        self.emit('error', err);
    }

    self.arg2.on('start', function onArg2Start() {
        if (!self.arg1._writableState.ended) self.arg1.end();
    });
    self.arg3.on('start', function onArg3Start() {
        if (!self.arg2._writableState.ended) self.arg2.end();
    });
}

inherits(ArgStream, EventEmitter);

function InArgStream() {
    var self = this;
    ArgStream.call(self);
    self.streams = [self.arg1, self.arg2, self.arg3];
    self._iStream = 0;
    self.finished = false;
    self._numFinished = 0;
    self.arg1.on('finish', argFinished);
    self.arg2.on('finish', argFinished);
    self.arg3.on('finish', argFinished);
    function argFinished() {
        if (++self._numFinished === 3) {
            self.finished = true;
            self.emit('finish');
        }
    }
}

inherits(InArgStream, ArgStream);

InArgStream.prototype.handleFrame = function handleFrame(parts) {
    var self = this;
    var stream = self.streams[self._iStream];

    if (parts === null) {
        while (stream) stream = advance();
        return;
    }

    if (self.finished) {
        throw new Error('arg stream finished'); // TODO typed error
    }

    for (var i = 0; i < parts.length; i++) {
        if (i > 0) stream = advance();
        if (!stream) break;
        if (parts[i].length) stream.write(parts[i]);
    }
    if (i < parts.length) {
        throw new Error('frame parts exceeded stream arity'); // TODO clearer / typed error
    }

    function advance() {
        if (self._iStream < self.streams.length) {
            self.streams[self._iStream].end();
            self._iStream++;
        }
        return self.streams[self._iStream];
    }
};

function OutArgStream() {
    var self = this;
    ArgStream.call(self);
    self._flushImmed = null;
    self.finished = false;
    self.frame = [Buffer(0)];
    self.currentArgN = 1;
    self.ended = [null, false, false, false];
    self.arg1.on('data', function onArg1Data(chunk) {
        self._handleFrameChunk(1, chunk);
    });
    self.arg2.on('data', function onArg2Data(chunk) {
        self._handleFrameChunk(2, chunk);
    });
    self.arg3.on('data', function onArg3Data(chunk) {
        self._handleFrameChunk(3, chunk);
    });

    self.arg1.on('end', function onArg1End() {
        self._handleFrameChunk(1, null);
    });
    self.arg2.on('end', function onArg2End() {
        self._handleFrameChunk(2, null);
    });
    self.arg3.on('end', function onArg3End() {
        self._handleFrameChunk(3, null);
        if (!self.paused) {
            // console.log('arg3 end flush');
            self._flushParts(true);
        }
        self.finished = true;
        self.emit('finish');
    });
    self.paused = false;
}

inherits(OutArgStream, ArgStream);

OutArgStream.prototype.pause = function pause() {
    var self = this;
    self.paused = true;
    self.arg1.pause();
    self.arg2.pause();
    self.arg3.pause();
    if (self._flushImmed) {
        clearImmediate(self._flushImmed);
        self._flushImmed = null;
    }
};

OutArgStream.prototype.resume = function resume() {
    var self = this;
    self.paused = false;
    self.arg1.resume();
    self.arg2.resume();
    self.arg3.resume();
    // console.log('final flush on resume');
    self._maybeFlush();
};

OutArgStream.prototype._handleFrameChunk = function _handleFrameChunk(n, chunk) {
    var self = this;
    console.log(
        'handleFrameChunk cur=%j chunk=%j paused=%j finished=%j chunk:',
        self.currentArgN, n, self.paused, self.finished, chunk && chunk.toString());

    if (n < self.currentArgN) {
        if (chunk === null) {
            self.ended[n] = true;
        } else {
            self.emit('error', ArgChunkOutOfOrderError({
                current: self.currentArgN,
                got: n,
                chunk: chunk
            }));
        }
        return;
    } else if (n > self.currentArgN) {
        if (chunk === null) {
            self.ended[n] = true;
            return;
        } else {
            // if (n - self.currentArgN > 1) {
            //     self.emit('error', ArgChunkGapError({
            //         current: self.currentArgN,
            //         got: n
            //     }));
            // }
            while (++self.currentArgN < n) self.frame.push(Buffer(0));
            self.frame.push(chunk);

        }
    } else if (chunk === null) {
        self.ended[n] = true;
    } else {
        self._appendFrameChunk(chunk);
    }

    while (self.ended[self.currentArgN]) {
        if (++self.currentArgN <= 3) self.frame.push(Buffer(0));
    }
    // console.log('yar', self.frame, self.currentArgN, self.ended);
    // console.log('final flush');
    self._maybeFlush();
};

OutArgStream.prototype._appendFrameChunk = function _appendFrameChunk(chunk) {
    var self = this;
    var i = self.frame.length - 1;
    var buf = self.frame[i];
    if (buf.length) {
        if (chunk.length) {
            self.frame[i] = Buffer.concat([buf, chunk]);
        }
    } else {
        self.frame[i] = chunk;
    }
};

OutArgStream.prototype._maybeFlush = function _maybeFlush() {
    var self = this;
    if (self.finished && self.ended[1] && self.ended[2] && self.ended[3]) {
        console.log('want to flush last now');
        self._flushParts(true);
    } else if (self.frame.length > 1 || self.frame[0].length) {
        console.log('want to defer flush');
        self._deferFlushParts();
    } else {
        console.log('NOT!', self.frame);
    }
};

OutArgStream.prototype._deferFlushParts = function _deferFlushParts() {
    var self = this;
    if (!self._flushImmed && !self.paused) {
        self._flushImmed = setImmediate(function() {
            self._flushParts();
        });
    }
};

OutArgStream.prototype._flushParts = function _flushParts(isLast) {
    var self = this;
    if (self._flushImmed) {
        clearImmediate(self._flushImmed);
        self._flushImmed = null;
    }
    if (self.paused) return;
    if (self.finished && !isLast) return;
    isLast = Boolean(isLast);
    var frame = self.frame;
    self.frame = [Buffer(0)];
    console.log('flush', frame, isLast);
    if (frame.length) self.emit('frame', frame, isLast);
};

function StreamArg(options) {
    if (!(this instanceof StreamArg)) {
        return new StreamArg(options);
    }
    var self = this;
    PassThrough.call(self, options);
    self.started = false;
    self.onValueReady = self.onValueReady.bind(self);
}
inherits(StreamArg, PassThrough);

StreamArg.prototype._write = function _write(chunk, encoding, callback) {
    var self = this;
    if (!self.started) {
        self.started = true;
        self.emit('start');
    }
    PassThrough.prototype._write.call(self, chunk, encoding, callback);
};

StreamArg.prototype.onValueReady = function onValueReady(callback) {
    var self = this;
    self.onValueReady = Ready();
    bufferStreamData(self, self.onValueReady.signal);
    self.onValueReady(callback);
};

function bufferStreamData(stream, callback) {
    var parts = [];
    stream.on('data', onData);
    stream.on('error', finish);
    stream.on('end', finish);
    function onData(chunk) {
        parts.push(chunk);
    }
    function finish(err) {
        stream.removeListener('data', onData);
        stream.removeListener('error', finish);
        stream.removeListener('end', finish);
        var buf = Buffer.concat(parts);
        if (err === undefined) err = null;
        callback(err, buf);
    }
}

module.exports.InArgStream = InArgStream;
module.exports.OutArgStream = OutArgStream;

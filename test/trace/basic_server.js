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

var CountedReadySignal = require('ready-signal/counted');
var DebugLogtron = require('debug-logtron');
var test = require('tape');

var TracingAgent = require('../../trace/agent');
var TChannel = require('../../channel.js');
var EndpointHandler = require('../../endpoint-handler.js');

var logger = DebugLogtron('example');

var fixture = require('./basic_server_fixture');
var validators = require('../lib/simple_validators');

test('basic tracing test', function (assert) {

    var spans = [];

    TracingAgent.getInstance().configure({
        reporter: function (span) {
            spans.push(span);
            console.log(span.toString());
        }
    });

    TracingAgent.getInstance().enableAutoTracePropagate();

    var subservice = new TChannel({
        handler: EndpointHandler(),
        serviceName: 'subservice',
        logger: logger,
        trace: true
    });

    var server = new TChannel({
        serviceName: 'server',
        handler: EndpointHandler(),
        logger: logger,
        trace: true
    });

    var client = new TChannel({
        logger: logger,
        trace: true
    });

    subservice.handler.register('/foobar', function (req, res) {
        console.log("subserv sr");
        res.sendOk('result', 'success');
    });

    // normal response
    server.handler.register('/top_level_endpoint', function (req, res) {
        console.log("top level sending to subservice");
        setTimeout(function () {
            server
                .request({host: '127.0.0.1:4042', serviceName: 'subservice', trace: true})
                .send('/foobar', 'arg1', 'arg2', function (err, subRes) {
                    console.log("top level recv from subservice");
                    if (err) return res.sendOk('error', err);
                    res.sendOk('result', 'success: ' + subRes);
                });
        }, 40);
    });

    var ready = CountedReadySignal(3);
    var requestsDone = CountedReadySignal(1);

    ready(function (err) {
        if (err) {
            throw err;
        }

        console.log("client making req");
        client
            .request({host: '127.0.0.1:4040', serviceName: 'server', trace: true})
            .send('/top_level_endpoint', "arg 1", "arg 2", function (err, res) {
                console.log("client recv from top level: " + res);
                requestsDone.signal();
            });

    });

    server.listen(4040, '127.0.0.1', ready.signal);
    client.listen(4041, '127.0.0.1', ready.signal);
    subservice.listen(4042, '127.0.0.1', ready.signal);

    requestsDone(function () {
        setTimeout(function () {
            // we clean up spans in their toJSON method for transport, so
            // do that and then validate them
            var cleanspans = spans.map(function (item) {
                return item.toJSON();
            });
            validators.validateSpans(assert, cleanspans, fixture);

            assert.end();
            client.close();
            server.close();
            subservice.close();
        }, 10);
    });
});

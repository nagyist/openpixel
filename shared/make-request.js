'use strict';
var request = require('request');
const fs = require('fs');

function parse_body(body) {
    try {
        return { err: null, json: JSON.parse(body) };
    }
    catch (e) {
        return { err: e, body: body }
    }
}

module.exports = function (options, debug_msg, on_error) {
    return {
        send: function (sub_url, other, callback) {
            //other = { method, json, data, file, ok_code }
            var method  = other.method || 'GET';
            var json    = other.json;
            var data    = other.data;
            var file    = other.file;
            var ok_code = other.ok_code || 200;
            var headers = other.headers;

            var req = {
                uri: options.base_url + sub_url,
                method: method
            };
            if (other.json) {
                req.json = json;
            }
            else if (data) {
                req.body = data;
            }
            if (headers) {
                let h = Object.keys(headers);
                if (!req.headers) {
                    req.headers = {};
                }
                for (let i = h.length - 1; i >= 0; i--) {
                    req.headers[h[i]] = headers[h[i]];
                }
            }

            if (options.user) {
                req.auth = {
                    'user': options.user.accessKey,
                    'pass': options.user.accessSecret,
                    'sendImmediately': true
                };
            }
            if (options.timeout) {
                req.timeout = options.timeout;
            }

            if (file && method === 'POST') {
                req.formData = {
                    file: [
                        fs.createReadStream(file)
                    ]
                };
            }

            debug_msg(`Prepared request: ${JSON.stringify(req)}`);

            var tries = 0;
            var responses = [];
            function make_request() {
                tries += 1;
                request(req, function (err, response, body) {
                    if (err) {
                        if (tries <= options.max_tries) {
                            on_error(`Request failed, will retry (${tries}/${options.max_tries}). Error`, err);
                            responses.push(err);
                            return make_request();
                        }
                        else {
                            on_error(`Request failed, giving up. Error`, err);
                            return callback(new Error(`${options.max_tries} consecutive errors: ${JSON.stringify(responses)}`), {});
                        }
                    }
                    if (response.statusCode != ok_code) {
                        if (tries <= options.max_tries) {
                            on_error(`Invalid response status code: expected ${ok_code}, but got ${response.statusCode}, will retry (${tries}/${options.max_tries})`);
                            responses.push(response.statusCode);
                            return make_request();
                        }
                        else {
                            on_error(`Invalid response status code: expected ${ok_code}, but got ${response.statusCode}, giving up`);
                            return callback(new Error(`${options.max_tries} consecutive errors: ${JSON.stringify(responses)}`), {});
                        }
                    }
                    debug_msg(`Got successfull response, body: ${JSON.stringify(body)}`);
                    return callback(null, body);
                });
            }
            make_request();
        }
    };
};

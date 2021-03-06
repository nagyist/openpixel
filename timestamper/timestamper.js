'use strict';

const fs     = require('fs');
const path   = require('path');
const OS     = require('os');
const config = require('../get-config');
const logger = require('../shared/logger')(config.timestamper.logger);
const utils  = require('../shared/utils');

logger.log('Starting, pid = ' + process.pid);
var tdur = process.hrtime();

const run_lock = path.join(__dirname, '../run_lock');

function exit(code, rm_run_lock) {
    code = code || 0;
    if (rm_run_lock) {
        logger.log(`Removing run-lock file ${run_lock}`);
        fs.unlinkSync(run_lock);
    }
    tdur = process.hrtime(tdur);
    logger.log(`Script exits, code = ${code}. Total ${utils.hrt2sec(tdur)} elapsed`);
    process.exit(code);
}

function should_run() {
    logger.log(`Checking the existence of run-lock file = ${run_lock}`);
    if (!utils.fexists(run_lock, fs.R_OK | fs.W_OK)) {
        logger.log(`Run-lock file does not exist, creating`);
        fs.writeFileSync(run_lock, `running since ${(new Date).toISOString()}, pid = ${process.pid}`);
        return true;
    }

    logger.error(`Run-lock file exists, another instance of this script is ${fs.readFileSync(run_lock)}.`);
    return false;
}

var ls, file_ok, file_failed;
if (config.timestamper.files_source === 'amqp') {
    var amqp = require('amqp');
    logger.log('ls = amqp');
    ls = function (_uu1, _uu2, _uu3, done) {
        logger.log(`Reading files from amqp queue ${config.timestamper.amqp_queue} in ${config.timestamper.amqp_url}`);
        var files_length_prev = 0;
        var files = [];

        var amqp_conn, amqp_queue, qlc;

        var amqp_conn = amqp.createConnection({ url: config.timestamper.amqp_url });
        amqp_conn.on('error', function (err) {
            logger.error('AMQP error', err);
            clearInterval(qlc);
            amqp_conn.disconnect();
            return done(err, []);
        });

        amqp_conn.on('ready', function () {
            logger.debug('AMQP ready');
            amqp_conn.queue(config.timestamper.amqp_queue, { passive: true, durable: true }, function (q) {
                amqp_queue = q;
                amqp_queue.bind('#');
                amqp_queue.subscribe({ ack: true }, function (message) {
                    files.push(message.data.toString());
                    amqp_queue.shift();
                });

                // checks if files.length didn't change -- assumes that all messages have been consumed for now
                qlc = setInterval(function () {
                    if (files_length_prev === files.length) {
                        clearInterval(qlc);
                        // amqp_queue.unsubscribe();
                        amqp_conn.disconnect();
                        return done(null, files);
                    }
                    else {
                        files_length_prev = files.length;
                    }
                }, 500);
            });
        });
    };
    file_ok = (fname, done) => done();
    file_failed = (fname, done) => done();
}
else if (config.timestamper.files_source === 'postgres') {
    logger.log('Reading files from postgres queue');
    ls = function (_uu1, _uu2, _uu3, done) {
        counters_storage.queue_get_files(function (err, rows) {
            var files = [];
            if (rows) {
                files = rows.map((r) => r.fname);
            }
            done(err, files);
        });
    };
    file_ok = (fname, done) => counters_storage.file_ok(fname, done);
    file_failed = (fname, done) => counters_storage.file_failed(fname, done);
}
else {
    logger.log(`Reading files in folder ${dir}`);
    ls = function (dir, ignore_dot, ext, done) {
        fs.readdir(dir, (err, all_files) => {
            if (err) {
                return done(err, [], {});
            }
            var files = [];
            for (let i = 0; i < all_files.length; i++) {
                if ((ignore_dot || all_files[i].startsWith('.')) && (!ext || all_files[i].endsWith(`.${ext}`))) {
                    files.push(path.join(config.timestamper.logs_folder, all_files[i]));
                }
            }
            done(null, files);
        });
    };
    file_ok = (fname, done) => done();
    file_failed = (fname, done) => done();
}

function get_hostname(fname, ext) {
    return path.basename(fname, `.${ext}`);
}

function get_counters_fname(hostname, ext) {
    return path.join(config.timestamper.processed_counters_folder, `${hostname}.counters.${ext}`);
}

function deserialize(line) {
    try {
        return JSON.parse(line);
    }
    catch (e) {
        logger.error(`Exception occured parsing line ${line}:`, e);
        return null;
    }
}

function parse_line(line) {
    var data = deserialize(line);
    if (!data) {
        logger.error(`Skipping unparsable line ${line}`);
        return null;
    }

    if (!data) {
        logger.error(`Skipping incorrect line, missing time. Original line: ${line}`);
        return null;
    }

    if (!data.req) {
        logger.error(`Skipping incorrect line, missing req object. Original line: ${line}`);
        return null;
    }

    if (!data.req.headers) {
        logger.error(`Skipping incorrect line, missing req.headers. Original line: ${line}`);
        return null;
    }

    // if (!data.req.headers.referer) {
    //     logger.error(`Skipping incorrect line, missing req.headers.referer. Original line: ${line}`);
    //     return null;
    // }

    if (data.req.headers.referer) {
        var hp = utils.get_hostname_pathname(data.req.headers.referer);
        if (hp.err) {
            logger.error(`Error occured while trying to get hostname and pathname from referer ${data.req.headers.referer}, err:`, hp.err);
            return null;
        }
    }
    else {
        var hp = {
            hostname: '_no_referer_',
            pathname: ''
        }
    };

    return {
        time:     data.time,
        hostname: hp.hostname,
        pathname: hp.pathname
    };
}

// --------- MAIN ----------- //

if (!should_run()) {
    return exit(2);
}

const ext = config.timestamper.extension || 'log';
const file_reader = require('./reader')(ext);

const counters_storage = require('../counters-storage');
const ledger = require('../ledger');

ls(config.timestamper.logs_folder, true, ext, function (err, files) {
    if (err) {
        if (err.code === 'ENOENT') {
            logger.error(`Logs folder does not exist ${config.timestamper.logs_folder}`);
            return exit(2, true);
        }
        throw err;
    }

    if (files.length === 0) {
        if (config.timestamper.missing_ok) {
            logger.log(`No log files to parse in ${config.timestamper.logs_folder}`);
            return exit(0, true);
        }
        else {
            logger.error(`No log files to parse in ${config.timestamper.logs_folder}`);
            return exit(1, true);
        }
    }

    files = files
            .map((fn) => {
                return {
                    name: fn,
                    size: fs.statSync(fn).size
                };
            })
            .sort((fo1, fo2) => {
                if (fo1.name === fo2.name) {
                    return fo2.size - fo1.size
                }
                else if (fo1.name < fo2.name) {
                    return -1;
                }
                else if (fo1.name > fo2.name) {
                    return +1;
                }
            });

    var meta = {};
    for (let i = 0; i < files.length; i++) {
        meta[files[i].name] = {
            size: files[i].size
        };
    }

    files = files.map((fo) => fo.name);
    logger.log(`Files to be processed: ${files.join(', ')}`);
    // return exit(0, true);

    const ccf = Math.min(files.length, config.timestamper.concurrent_files);
    logger.log(`Will process ${ccf} files concurrently`);
    var i = ccf - 1; // files counter
    var p = 0;       // processed files counter
    var failed_files = [];
    var journal;
    var too_many_failed = false;
    var log_time;

    function stamp() {
        logger.log('Stamping successfully processed files');
        var dur = process.hrtime();
        ledger.stamp(journal, function (err) {
            dur = process.hrtime(dur);
            if (err) {
                logger.error('Error stamping the files in ledger:', err);
                return exit(1, true);
            }
            logger.log(`Files were successfully stamped in ledger, journal_id = ${journal.id}, ${utils.hrt2sec(dur)} elapsed`);
            dur = process.hrtime();
            counters_storage.acknowledge_stamp(journal.id, function (err) {
                dur = process.hrtime(dur);
                if (err) {
                    logger.error('Error stamping the files in counters storage:', err);
                    return exit(1, true);
                }
                logger.log(`Files were successfully stamped in counters storage, ${utils.hrt2sec(dur)} elapsed`);

                logger.log('Waiting to get txid from ledger');
                ledger.get_txid(journal, function (err, txid) {
                    if (err) {
                        logger.error('Error getting txid from ledger:', err);
                        return exit(1, true);
                    }

                    logger.log('Got txid from ledger: ' + txid);
                    counters_storage.set_txid(journal.id, txid, function (err) {
                        if (err) {
                            logger.error('Error setting txid in counters storage:', err);
                            return exit(1, true);
                        }

                        logger.log('Updated txid in counters storage');
                        if (failed_files.length > 0) {
                            return exit(1, true);
                        }
                        else {
                            counters_storage.update_usage_stat({ log_time: log_time }, function (err) {
                                if (err) {
                                    logger.error(`Error updating usage stat for log time ${log_time}`, err);
                                }
                                else {
                                    logger.log(`Updated usage stat for log time: ${log_time}`);
                                }
                                return exit(0, true);
                            });
                        }
                    });
                });
            });
        });
    }

    function next_file(fname, err) {
        if (err) {
            logger.error(`Skipping file ${fname}`);
            failed_files.push(fname);
            if (config.timestamper.max_failed_files != null && failed_files.length > config.timestamper.max_failed_files) {
                too_many_failed = true;
                logger.error(`Too many files failed to be stamped (max ${config.timestamper.max_failed_files})`);
            }
        }
        if (too_many_failed && p >= i || p >= files.length - 1) {
            logger.log(`Completed processing files. Total files processed: ${i+1}, failed to add: ${failed_files.length}`);
            if (failed_files.length > 0) {
                logger.error(`Failed to add ${failed_files.length} files: ${failed_files.map((f) => path.basename(f)).join(', ')}`);
            }
            if (too_many_failed) {
                return exit(1, true);
            }
            else {
                return stamp();
            }
        }
        else {
            p += 1;
            if (too_many_failed || i >= files.length - 1) {
                logger.log(`No new files to be processed, but awaiting ${i+1 - p} more files to finish processing`);
            }
            else {
                i += 1;
                parse_file(files[i], next_file);
            }
        }
    }

    function parse_file(fname, next_file) {
        var hostname = get_hostname(fname, ext);
        logger.log(`Trying to parse logs of ${hostname} from ${fname}`);
        var total_counter = {};
        var fdur = process.hrtime();
        var dur = process.hrtime();
        file_reader.read_by_line(fname,
            function (err) {
                logger.error(`Error reading line from file = ${fname}, err:`, err);
                return next_file(fname, err);
            },
            function (line) {
                logger.debug(`Trying to parse line = ${line}`);
                var counter = parse_line(line);
                logger.debug(`Line processed, counter = ${JSON.stringify(counter)}`);
                if (!counter) {
                    return;
                }
                var t = counter.time.substr(0,13);
                if (!log_time) {
                    log_time = counter.time;
                    logger.log(`Assuming log_time = ${log_time} for ${hostname}`);
                }
                if (!total_counter[t]) {
                    total_counter[t] = {};
                }
                if (!total_counter[t][counter.hostname]) {
                    total_counter[t][counter.hostname] = {};
                }
                if (!total_counter[t][counter.hostname][counter.pathname]) {
                    total_counter[t][counter.hostname][counter.pathname] = 0;
                }
                total_counter[t][counter.hostname][counter.pathname] += 1;
            },
            function () {
                dur = process.hrtime(dur);
                logger.log(`File for ${hostname} processed, ${utils.hrt2sec(dur)} elapsed`);
                var counters_fname = get_counters_fname(hostname, ext);
                dur = process.hrtime();
                file_reader.write(counters_fname, JSON.stringify(total_counter), function (err) {
                    dur = process.hrtime(dur);
                    if (err) {
                        logger.error(`Could not save counters file for ${hostname} in ${counters_fname}, err:`, err);
                        return next_file(fname, err);
                    }
                    logger.log(`Counters file saved for ${hostname} in ${counters_fname}, ${utils.hrt2sec(dur)} elapsed`);

                    dur = process.hrtime();
                    ledger.add(journal, fname, counters_fname, function (err, rest) {
                        dur = process.hrtime(dur);
                        if (err) {
                            logger.error(`Failed to add ${hostname} to ledger, err:`, err);
                            counters_storage.queue_file_failed(fname, function () {});
                            return next_file(fname, err);
                        }
                        counters_storage.queue_file_ok(fname, function () {});
                        logger.log(`Added ${hostname} to ledger, ${utils.hrt2sec(dur)} elapsed`);

                        dur = process.hrtime();
                        counters_storage.incr_by_json(total_counter, function (err) {
                            dur = process.hrtime(dur);
                            if (err) {
                                logger.error(`Error updating counters in storage for ${hostname}:`, err);
                                return next_file(fname, err);
                            }
                            logger.log(`Storage updated for ${hostname}, ${utils.hrt2sec(dur)} elapsed`);

                            dur = process.hrtime();
                            var log_fsize = meta[fname].size;
                            var counters_fsize = fs.statSync(counters_fname).size;
                            counters_storage.save_ledger_data(log_time, hostname, journal.id, rest, log_fsize, counters_fsize, function (err) {
                                dur = process.hrtime(dur);
                                if (err) {
                                    logger.error(`Error saving ledger data for ${hostname}:`, err);
                                    return next_file(fname, err);
                                }
                                logger.log(`Ledger data saved for ${hostname}, ${utils.hrt2sec(dur)} elapsed`);
                                fdur = process.hrtime(fdur);
                                logger.log(`Done with logs for ${hostname}, ${utils.hrt2sec(fdur)} elapsed`);
                                return next_file(fname);
                            });
                        });
                    });
                });
            }
        );
    }

    logger.log('Initializing counters storage');
    counters_storage.init(function (err) {
        if (err) {
            logger.error('Could not initialize counters storage, err:', err);
            return exit(1, true);
        }
        logger.debug('Counters storage initialized');

        logger.log('Opening ledger');
        ledger.open(function (err, new_journal) {
            if (err) {
                logger.error('Could not open ledger, err:', err);
                return exit(1, true);
            }
            logger.debug('Ledger opened successfully');
            journal = new_journal;

            // opening the first bunch of files
            for (let ccfi = 0; ccfi < ccf; ccfi++) {
                parse_file(files[ccfi], next_file);
            }
        }, counters_storage.per_stamped_file, function (fname) { return get_hostname(fname, ext); });
    });
});

var async = require("async"),
    fs = require("fs"),
    _ = require("lodash");

module.exports = function setupSync(model, api, options)
{
    if (model.linvoSync) return;
    model.linvoSync = true;

    var options = options || {};

    var status = function(s) {
        if (options.log) console.log("LinvoDB Sync: "+s);
    };

    var dirty = false;
    var triggerSync = function(cb)
    { 
        dirty = true;
        q.push({}, cb);
    };
    model.on("updated", function(items, quiet) { if (!quiet) triggerSync() });
    model.on("inserted", function(items, quiet) { if (!quiet) triggerSync() });
    model.static("triggerSync", triggerSync);

    var mtimes = {};
    model.on("reset", function() { mtimes = {} });
    model.on("refresh", function() { triggerSync() });
    model.on("construct", function(x) { if (x._id && x._mtime) mtimes[x._id] = x._mtime });
    model.on("save", function(x) { if (x._id && x._mtime) mtimes[x._id] = x._mtime });

    /* We need to run only one task at a time */
    var q = async.queue(function(opts, cb)
    {
        if (! api.user) return cb();
        if (! dirty) return cb();

        var baseQuery = { collection: options.remoteCollection || model.modelName };
        var remote = {}, push = [], pull = [];

        async.auto({
            ensure_indexes: function(callback) { // Meaningless lookup to Ensure the DB has been indexed
                model.count({ }, function(err, c) { 
                    callback();
                }, true);
            },
            retrieve_remote: function(callback)
            {
                api.request("datastoreMeta", baseQuery, function(err, meta)
                { 
                    if (err) return callback(err);

                    meta.forEach(function(m) { remote[m[0]] = new Date(m[1]).getTime() });
                    callback();
                });
            },
            compile_changes: ["ensure_indexes", "retrieve_remote", function(callback)
            {
                var pushIds = [];
                Object.keys(mtimes).forEach(function(id) {
                    var mtime = mtimes[id];
                    if ((remote[id] || 0) > mtime.getTime()) pull.push(id);
                    if ((remote[id] || 0) < mtime.getTime()) pushIds.push(id);
                    delete remote[id]; // already processed
                });

                pull = pull.concat(_.keys(remote)); // add all non-processed to pull queue
                
                model.find({ _id: { $in: pushIds } }, function(err, res) {
                    if (err) return callback(err);

                    push = res;
                    callback();
                }, true);

                // It's correct to mark the DB before commiting the changes, but when compiling the list of changes
                // Until the changes are commited, more changes might occur
                dirty = false;
            }],
            push_remote: ["compile_changes", function(callback)
            {
                if (push.length) status("pushing "+push.length+" changes to remote for "+model.modelName);

                if (! push.length) return callback();

                api.request("datastorePut", _.extend({ }, baseQuery, { changes: 
                    push.map(function(x) { 
                        var item = _.extend({ }, x);
                        if (x._mtime) x._mtime = x._mtime.getTime();
                        if (x._ctime) x._ctime = x._ctime.getTime();
                        return item;
                    })
                }), callback);
            }],
            pull_local: ["compile_changes", function(callback)
            {
                if (! pull.length) return callback();
                
                api.request("datastoreGet", _.extend({ }, baseQuery, { ids: pull }), function(err, results)
                {
                    if (err) return callback(err);

                    if (results.length) status("pulled "+results.length+" down for "+model.modelName);

                    results.forEach(function(x) {
                        x._ctime = new Date(x._ctime || 0);
                        x._mtime = new Date(x._mtime || 0);
                    });

                    model.save(results, function(err)
                    {
                        if (err) console.error(err);
                        callback();

                        if (results.length) model.emit("liveQueryRefresh");
                    }, true); // True for quiet mode, not emit any events
                });
            }],
            finalize: ["push_remote", "pull_local", function(callback)
            {
                status("sync finished for "+model.modelName);
                
                model.emit("syncFinished");

                callback();
            }]
        }, cb);
    }, 1);
}

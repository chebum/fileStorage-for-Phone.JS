"use strict";

// Will initialize File API functions in your namespace

var FS = {};

(function ($, DX, ns) {
    ns.trivialPromise = function (_) {
        var d = $.Deferred();
        return d.resolve.apply(d, arguments).promise()
    };

    ns.rejectedPromise = function (_) {
        var d = $.Deferred();
        return d.reject.apply(d, arguments).promise()
    };

    ns.date = function (date) {
        date = date || new Date();
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    };

    ns.initFileAPI = function (bytesNeeded, persistent) {
        if (ns.fs)
            return ns.trivialPromise(true);

        if (persistent === undefined)
            persistent = true;

        var d = $.Deferred();

        function initFS(fs) {
            fs.root.getDirectory('data', { create: true }, function (dirEntry) {
                ns.fs = fs;
                ns.dataRoot = dirEntry;
                d.resolve();
            }, errorHandler);
        }

        function errorHandler(e) {
            ns.fs = null;
            ns.dataRoot = null;
            d.reject(e);
        }

        function requestFS() {
            window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
            var deviceInfo = DevExpress.devices.current();
            window.requestFileSystem(fsType, deviceInfo.android ? 0 : bytesNeeded,
                initFS, errorHandler);
        }

        var fsType;
        if (typeof LocalFileSystem !== "undefined")
            fsType = persistent ? LocalFileSystem.PERSISTENT : LocalFileSystem.TEMPORARY;
        else
            fsType = persistent ? window.PERSISTENT : window.TEMPORARY;

        var storageInfo = persistent ? navigator.webkitPersistentStorage : navigator.webkitTemporaryStorage;
        if (storageInfo) {
            storageInfo.requestQuota(bytesNeeded, function (grantedBytes) {
                requestFS();
            }, function (e) {
                d.reject(e);
            });
        } else
            requestFS();

        return d.promise();
    };

    ns.writeFile = function (fileName, content) {
        if (!ns.fs)
            ns.rejectedPromise("This method requires initialized persistent File API");
        var d = $.Deferred();
        ns.dataRoot.getFile(fileName, { create: true }, function (fileEntry) {
            fileEntry.createWriter(function (fileWriter) {
                var blob;
                try {
                    blob = new Blob([content], { type: 'text/plain' });
                } catch (e) {
                    blob = content;
                }
                fileWriter.onwriteend = function () {
                    if (fileWriter.length == 0)
                        fileWriter.write(blob);
                    if (fileWriter.length === content.length)
                        d.resolve(true);
                };
                fileWriter.truncate(0);
            }, function (e) {
                d.reject(e)
            });
        }, function (e) {
            d.reject(e)
        });
        return d;
    };

    ns.readFile = function (fileName) {
        if (!ns.fs)
            ns.rejectedPromise("This method requires initialized persistent File API");
        var d = $.Deferred();
        ns.dataRoot.getFile(fileName, { create: false }, function (fileEntry) {
            fileEntry.file(function (file) {
                var reader = new FileReader();

                reader.onloadend = function () {
                    if (d.state() === "resolved")
                        d.reject("double resolve");
                    else
                        d.resolve(this.result);
                };

                reader.readAsText(file);
            }, function (e) {
                d.reject(e)
            });
        }, function () {
            d.resolve(null);
        });
        return d;
    };

    ns.removeFile = function (fileName) {
        if (!ns.fs)
            ns.rejectedPromise("This method requires initialized persistent File API");
        var d = $.Deferred();
        ns.dataRoot.getFile(fileName, { create: false }, function (fileEntry) {
            fileEntry.remove(function () {
                d.resolve(true);
            }, function () {
                d.resolve(false);
            });
        }, function () {
            d.resolve(null);
        });
        return d;
    }

    ns.FileArrayStore = DX.data.Store.inherit({
        ctor: function (options) {
            if ($.isArray(options))
                options = { data: options };
            else
                options = options || {};
            this.callBase(options);

            if (!this.key())
                throw Error("requires keyExpr");

            this._array = options.data || [];
            this._fileName = options.fileName || null;
            this._loadPromise = null;
            this._reviver = options.reviver || null;
            this._flushScheduled = false;
            this._jsonifiedArray = [];
            this._keyMap = {};
            this.generator = ns.createKeyGenerator(0);
            for (var i = 0; i < this._array.length; i++) {
                var key = this.keyOf(this._array[i]);
                this._keyMap[key] = i;
                this.generator.fix(key);
                this._jsonifiedArray.push(null);
            }
        },
        createQuery: function () {
            return DX.data.query(this._array, { errorHandler: this._errorHandler });
        },
        _totalCountImpl: function (options) {
            var base = $.proxy(this.callBase, this);
            return this._load().then(function () {
                return base(options);
            });
        },
        _byKeyImpl: function (key) {
            var indexByKey = this._indexByKey(key);
            if (indexByKey < 0)
                return ns.trivialPromise(undefined);
            var item = this._array[indexByKey];
            if (item !== undefined && this.keyOf(item) != key)
                return ns.rejectedPromise("_indexByKey works incorrectly");
            return ns.trivialPromise(item);
        },
        _load: function () {
            if (!this._loadPromise) {
                if (this._fileName) {
                    this._loadPromise = ns.readFile(this._fileName)
                        .then(function (jsonString) {
                            this._erase();
                            if (!jsonString)
                                return ns.trivialPromise(false);
                            var i = 0;
                            while (i < jsonString.length) {
                                var separatorIndex = jsonString.indexOf(":", i);
                                if (separatorIndex < 0)
                                    return ns.rejectedPromise("malformed json string");
                                var length = parseInt(jsonString.substr(i, separatorIndex - i));
                                var jsonifiedItem = jsonString.substr(separatorIndex + 1, length);
                                this._jsonifiedArray.push(jsonifiedItem);
                                var obj;
                                if (this._reviver)
                                    obj = this._reviver(jsonifiedItem);
                                else
                                    obj = JSON.parse(jsonifiedItem);
                                this._array.push(obj);
                                var objKey = this.keyOf(obj);
                                this._keyMap[objKey] = this._array.length - 1;
                                this.generator.fix(objKey);
                                i = separatorIndex + 1 + length;
                            }
                            return ns.trivialPromise(true);
                        }.bind(this));
                } else
                    this._loadPromise = ns.trivialPromise();
            }
            return this._loadPromise;
        },
        _loadImpl: function (options) {
            var callBase = this.callBase.bind(this);
            return this._load().then(function () {
                return callBase(options);
            }.bind(this));
        },
        _insertImpl: function (values) {
            return this._load()
                .then(function () {
                    if (!$.isArray(values))
                        values = [values];
                    var keyExpr = this.key(),
                        keyValues = [],
                        obj;
                    for (var i = 0; i < values.length; i++) {
                        obj = $.extend({}, values[i]);
                        var keyValue = this.keyOf(obj);
                        if (keyValue === undefined || typeof keyValue === "object" && $.isEmptyObject(keyValue)) {
                            keyValue = obj[keyExpr] = this.generator.next();
                        } else {
                            if (this._keyMap[keyValue] !== undefined)
                                return ns.rejectedPromise("Attempt to insert an item with the duplicate key (" + keyValue + ", " + this._keyMap[keyValue] + ")");
                            this.generator.fix(keyValue);
                        }

                        keyValues.push(keyValue);
                        this._array.push(obj);
                        this._jsonifiedArray.push(null);
                        this._keyMap[keyValue] = this._array.length - 1;
                    }

                    this._scheduleFlush();
                    if (values.length == 1)
                        return ns.trivialPromise(values[0], keyValues[0]);
                    else
                        return ns.trivialPromise(values, keyValues);
                }.bind(this));
        },
        _updateImpl: function (key, values) {
            return this._load().then(function () {
                var index = this._indexByKey(key);
                if (index < 0)
                    return ns.rejectedPromise("Data item not found");
                var target = this._array[index];
                DX.utils.deepExtendArraySafe(target, values);
                if (this.keyOf(target) !== key)
                    ns.rejectedPromise("An attempt to change the key");
                this._jsonifiedArray[index] = null;
                this._scheduleFlush();
                return ns.trivialPromise(key, values);
            }.bind(this));
        },
        _removeImpl: function (key) {
            return this._load().then(function () {
                var index = this._indexByKey(key);
                if (index > -1) {
                    this._array.splice(index, 1);
                    this._jsonifiedArray.splice(index, 1);
                    delete this._keyMap[key];
                    for (var k in this._keyMap) {
                        if (this._keyMap[k] > index)
                            this._keyMap[k]--;
                    }
                    this._scheduleFlush();
                }
                return ns.trivialPromise(key);
            }.bind(this));
        },
        _scheduleFlush: function () {
            if (!this._fileName || this._flushScheduled)
                return;
            this._flushScheduled = true;
            setTimeout(function () {
                if (this._flushScheduled)
                    this.flush();
            }.bind(this), 3000);
        },
        flush: function () {
            var jsonString = "";
            for (var i = 0; i < this._jsonifiedArray.length; i++) {
                if (this._jsonifiedArray[i] == null)
                    this._jsonifiedArray[i] = JSON.stringify(this._array[i]);
                jsonString += this._jsonifiedArray[i].length;
                jsonString += ":";
                jsonString += this._jsonifiedArray[i];
            }
            return ns.writeFile(this._fileName, jsonString).done(function () {
                this._flushScheduled = false;
                console.log("file '" + this._fileName + "' written");
            }.bind(this));
        },
        erase: function () {
            this._erase();
            if (!this._fileName)
                return ns.trivialPromise();
            return ns.removeFile(this._fileName);
        },
        _erase: function () {
            this._flushScheduled = false;
            this._jsonifiedArray.length = 0;
            this._array.length = 0;
            this._keyMap = {};
        },
        _indexByKey: function (key) {
            var index = this._keyMap[key];
            return index !== undefined ? index : -1;
        }
    });

    ns.createKeyGenerator = function (startValue) {
        var currentValue = startValue || 0;
        return {
            next: function () {
                return ++currentValue;
            },
            fix: function (loadedKey) {
                if (currentValue < loadedKey)
                    currentValue = loadedKey + 1;
            },
            reset: function () {
                currentValue = 0;
            }
        };
    };
})(jQuery, DevExpress, FS);

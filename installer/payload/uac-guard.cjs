"use strict";
// Preloaded with --require before the server starts (see service.xml.template).
// Node looks for packages in every parent folder up to the drive root, and any local user can create
// C:\node_modules. Restrict the lookup to this installation, so a planted look-alike of an optional module
// (bufferutil, utf-8-validate, ...) is never loaded by the service.
const Module = require("module");
const path = require("path");

const root = path.resolve(__dirname, "..");
const keep = (dir) => {
    const relative = path.relative(root, dir);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const original = Module._nodeModulePaths;
Module._nodeModulePaths = function (from) {
    return original.call(this, from).filter(keep);
};

var MyModule = (function (fs, path$1, crypto$1) {
  'use strict';

  fs = fs && Object.prototype.hasOwnProperty.call(fs, 'default') ? fs['default'] : fs;
  path$1 = path$1 && Object.prototype.hasOwnProperty.call(path$1, 'default') ? path$1['default'] : path$1;
  crypto$1 = crypto$1 && Object.prototype.hasOwnProperty.call(crypto$1, 'default') ? crypto$1['default'] : crypto$1;

  // Runtime header offsets
  const ID_OFFSET = -8;
  const SIZE_OFFSET = -4;

  // Runtime ids
  const ARRAYBUFFER_ID = 0;
  const STRING_ID = 1;

  // Runtime type information
  const ARRAYBUFFERVIEW = 1 << 0;
  const ARRAY = 1 << 1;
  const VAL_ALIGN_OFFSET = 5;
  const VAL_SIGNED = 1 << 10;
  const VAL_FLOAT = 1 << 11;
  const VAL_MANAGED = 1 << 13;

  // Array(BufferView) layout
  const ARRAYBUFFERVIEW_BUFFER_OFFSET = 0;
  const ARRAYBUFFERVIEW_DATASTART_OFFSET = 4;
  const ARRAYBUFFERVIEW_DATALENGTH_OFFSET = 8;
  const ARRAYBUFFERVIEW_SIZE = 12;
  const ARRAY_LENGTH_OFFSET = 12;
  const ARRAY_SIZE = 16;

  const BIGINT = typeof BigUint64Array !== "undefined";
  const THIS = Symbol();
  const CHUNKSIZE = 1024;

  /** Gets a string from an U32 and an U16 view on a memory. */
  function getStringImpl(buffer, ptr) {
    const U32 = new Uint32Array(buffer);
    const U16 = new Uint16Array(buffer);
    var length = U32[(ptr + SIZE_OFFSET) >>> 2] >>> 1;
    var offset = ptr >>> 1;
    if (length <= CHUNKSIZE) return String.fromCharCode.apply(String, U16.subarray(offset, offset + length));
    const parts = [];
    do {
      const last = U16[offset + CHUNKSIZE - 1];
      const size = last >= 0xD800 && last < 0xDC00 ? CHUNKSIZE - 1 : CHUNKSIZE;
      parts.push(String.fromCharCode.apply(String, U16.subarray(offset, offset += size)));
      length -= size;
    } while (length > CHUNKSIZE);
    return parts.join("") + String.fromCharCode.apply(String, U16.subarray(offset, offset + length));
  }

  /** Prepares the base module prior to instantiation. */
  function preInstantiate(imports) {
    const baseModule = {};

    function getString(memory, ptr) {
      if (!memory) return "<yet unknown>";
      return getStringImpl(memory.buffer, ptr);
    }

    // add common imports used by stdlib for convenience
    const env = (imports.env = imports.env || {});
    env.abort = env.abort || function abort(mesg, file, line, colm) {
      const memory = baseModule.memory || env.memory; // prefer exported, otherwise try imported
      throw Error("abort: " + getString(memory, mesg) + " at " + getString(memory, file) + ":" + line + ":" + colm);
    };
    env.trace = env.trace || function trace(mesg, n) {
      const memory = baseModule.memory || env.memory;
      console.log("trace: " + getString(memory, mesg) + (n ? " " : "") + Array.prototype.slice.call(arguments, 2, 2 + n).join(", "));
    };
    imports.Math = imports.Math || Math;
    imports.Date = imports.Date || Date;

    return baseModule;
  }

  /** Prepares the final module once instantiation is complete. */
  function postInstantiate(baseModule, instance) {
    const rawExports = instance.exports;
    const memory = rawExports.memory;
    const table = rawExports.table;
    const alloc = rawExports["__alloc"];
    const retain = rawExports["__retain"];
    const rttiBase = rawExports["__rtti_base"] || ~0; // oob if not present

    /** Gets the runtime type info for the given id. */
    function getInfo(id) {
      const U32 = new Uint32Array(memory.buffer);
      const count = U32[rttiBase >>> 2];
      if ((id >>>= 0) >= count) throw Error("invalid id: " + id);
      return U32[(rttiBase + 4 >>> 2) + id * 2];
    }

    /** Gets the runtime base id for the given id. */
    function getBase(id) {
      const U32 = new Uint32Array(memory.buffer);
      const count = U32[rttiBase >>> 2];
      if ((id >>>= 0) >= count) throw Error("invalid id: " + id);
      return U32[(rttiBase + 4 >>> 2) + id * 2 + 1];
    }

    /** Gets the runtime alignment of a collection's values. */
    function getValueAlign(info) {
      return 31 - Math.clz32((info >>> VAL_ALIGN_OFFSET) & 31); // -1 if none
    }

    /** Allocates a new string in the module's memory and returns its retained pointer. */
    function __allocString(str) {
      const length = str.length;
      const ptr = alloc(length << 1, STRING_ID);
      const U16 = new Uint16Array(memory.buffer);
      for (var i = 0, p = ptr >>> 1; i < length; ++i) U16[p + i] = str.charCodeAt(i);
      return ptr;
    }

    baseModule.__allocString = __allocString;

    /** Reads a string from the module's memory by its pointer. */
    function __getString(ptr) {
      const buffer = memory.buffer;
      const id = new Uint32Array(buffer)[ptr + ID_OFFSET >>> 2];
      if (id !== STRING_ID) throw Error("not a string: " + ptr);
      return getStringImpl(buffer, ptr);
    }

    baseModule.__getString = __getString;

    /** Gets the view matching the specified alignment, signedness and floatness. */
    function getView(alignLog2, signed, float) {
      const buffer = memory.buffer;
      if (float) {
        switch (alignLog2) {
          case 2: return new Float32Array(buffer);
          case 3: return new Float64Array(buffer);
        }
      } else {
        switch (alignLog2) {
          case 0: return new (signed ? Int8Array : Uint8Array)(buffer);
          case 1: return new (signed ? Int16Array : Uint16Array)(buffer);
          case 2: return new (signed ? Int32Array : Uint32Array)(buffer);
          case 3: return new (signed ? BigInt64Array : BigUint64Array)(buffer);
        }
      }
      throw Error("unsupported align: " + alignLog2);
    }

    /** Allocates a new array in the module's memory and returns its retained pointer. */
    function __allocArray(id, values) {
      const info = getInfo(id);
      if (!(info & (ARRAYBUFFERVIEW | ARRAY))) throw Error("not an array: " + id + " @ " + info);
      const align = getValueAlign(info);
      const length = values.length;
      const buf = alloc(length << align, ARRAYBUFFER_ID);
      const arr = alloc(info & ARRAY ? ARRAY_SIZE : ARRAYBUFFERVIEW_SIZE, id);
      const U32 = new Uint32Array(memory.buffer);
      U32[arr + ARRAYBUFFERVIEW_BUFFER_OFFSET >>> 2] = retain(buf);
      U32[arr + ARRAYBUFFERVIEW_DATASTART_OFFSET >>> 2] = buf;
      U32[arr + ARRAYBUFFERVIEW_DATALENGTH_OFFSET >>> 2] = length << align;
      if (info & ARRAY) U32[arr + ARRAY_LENGTH_OFFSET >>> 2] = length;
      const view = getView(align, info & VAL_SIGNED, info & VAL_FLOAT);
      if (info & VAL_MANAGED) {
        for (let i = 0; i < length; ++i) view[(buf >>> align) + i] = retain(values[i]);
      } else {
        view.set(values, buf >>> align);
      }
      return arr;
    }

    baseModule.__allocArray = __allocArray;

    /** Gets a view on the values of an array in the module's memory. */
    function __getArrayView(arr) {
      const U32 = new Uint32Array(memory.buffer);
      const id = U32[arr + ID_OFFSET >>> 2];
      const info = getInfo(id);
      if (!(info & ARRAYBUFFERVIEW)) throw Error("not an array: " + id);
      const align = getValueAlign(info);
      var buf = U32[arr + ARRAYBUFFERVIEW_DATASTART_OFFSET >>> 2];
      const length = info & ARRAY
        ? U32[arr + ARRAY_LENGTH_OFFSET >>> 2]
        : U32[buf + SIZE_OFFSET >>> 2] >>> align;
      return getView(align, info & VAL_SIGNED, info & VAL_FLOAT)
            .subarray(buf >>>= align, buf + length);
    }

    baseModule.__getArrayView = __getArrayView;

    /** Reads (copies) the values of an array from the module's memory. */
    function __getArray(arr) {
      const input = __getArrayView(arr);
      const len = input.length;
      const out = new Array(len);
      for (let i = 0; i < len; i++) out[i] = input[i];
      return out;
    }

    baseModule.__getArray = __getArray;

    /** Reads (copies) the data of an ArrayBuffer from the module's memory. */
    function __getArrayBuffer(ptr) {
      const buffer = memory.buffer;
      const length = new Uint32Array(buffer)[ptr + SIZE_OFFSET >>> 2];
      return buffer.slice(ptr, ptr + length);
    }

    baseModule.__getArrayBuffer = __getArrayBuffer;

    function getTypedArrayImpl(Type, alignLog2, ptr) {
      const buffer = memory.buffer;
      const U32 = new Uint32Array(buffer);
      const bufPtr = U32[ptr + ARRAYBUFFERVIEW_DATASTART_OFFSET >>> 2];
      return new Type(buffer, bufPtr, U32[bufPtr + SIZE_OFFSET >>> 2] >>> alignLog2);
    }

    /** Gets a view on the values of a known-to-be Int8Array in the module's memory. */
    baseModule.__getInt8Array = getTypedArrayImpl.bind(null, Int8Array, 0);
    /** Gets a view on the values of a known-to-be Uint8Array in the module's memory. */
    baseModule.__getUint8Array = getTypedArrayImpl.bind(null, Uint8Array, 0);
    /** Gets a view on the values of a known-to-be Uint8ClampedArray in the module's memory. */
    baseModule.__getUint8ClampedArray = getTypedArrayImpl.bind(null, Uint8ClampedArray, 0);
    /** Gets a view on the values of a known-to-be Int16Array in the module's memory. */
    baseModule.__getInt16Array = getTypedArrayImpl.bind(null, Int16Array, 1);
    /** Gets a view on the values of a known-to-be Uint16Array in the module's memory. */
    baseModule.__getUint16Array = getTypedArrayImpl.bind(null, Uint16Array, 1);
    /** Gets a view on the values of a known-to-be Int32Array in the module's memory. */
    baseModule.__getInt32Array = getTypedArrayImpl.bind(null, Int32Array, 2);
    /** Gets a view on the values of a known-to-be Uint32Array in the module's memory. */
    baseModule.__getUint32Array = getTypedArrayImpl.bind(null, Uint32Array, 2);
    if (BIGINT) {
      /** Gets a view on the values of a known-to-be-Int64Array in the module's memory. */
      baseModule.__getInt64Array = getTypedArrayImpl.bind(null, BigInt64Array, 3);
      /** Gets a view on the values of a known-to-be-Uint64Array in the module's memory. */
      baseModule.__getUint64Array = getTypedArrayImpl.bind(null, BigUint64Array, 3);
    }
    /** Gets a view on the values of a known-to-be Float32Array in the module's memory. */
    baseModule.__getFloat32Array = getTypedArrayImpl.bind(null, Float32Array, 2);
    /** Gets a view on the values of a known-to-be Float64Array in the module's memory. */
    baseModule.__getFloat64Array = getTypedArrayImpl.bind(null, Float64Array, 3);

    /** Tests whether an object is an instance of the class represented by the specified base id. */
    function __instanceof(ptr, baseId) {
      const U32 = new Uint32Array(memory.buffer);
      var id = U32[(ptr + ID_OFFSET) >>> 2];
      if (id <= U32[rttiBase >>> 2]) {
        do if (id == baseId) return true;
        while (id = getBase(id));
      }
      return false;
    }

    baseModule.__instanceof = __instanceof;

    // Pull basic exports to baseModule so code in preInstantiate can use them
    baseModule.memory = baseModule.memory || memory;
    baseModule.table  = baseModule.table  || table;

    // Demangle exports and provide the usual utility on the prototype
    return demangle(rawExports, baseModule);
  }

  /** Wraps a WebAssembly function while also taking care of variable arguments. */
  function wrapFunction(fn, setargc) {
    var wrap = (...args) => {
      setargc(args.length);
      return fn(...args);
    };
    wrap.original = fn;
    return wrap;
  }

  function isResponse(o) {
    return typeof Response !== "undefined" && o instanceof Response;
  }

  /** Asynchronously instantiates an AssemblyScript module from anything that can be instantiated. */
  async function instantiate(source, imports) {
    if (isResponse(source = await source)) return instantiateStreaming(source, imports);
    return postInstantiate(
      preInstantiate(imports || (imports = {})),
      await WebAssembly.instantiate(
        source instanceof WebAssembly.Module
          ? source
          : await WebAssembly.compile(source),
        imports
      )
    );
  }

  var instantiate_1 = instantiate;

  /** Synchronously instantiates an AssemblyScript module from a WebAssembly.Module or binary buffer. */
  function instantiateSync(source, imports) {
    return postInstantiate(
      preInstantiate(imports || (imports = {})),
      new WebAssembly.Instance(
        source instanceof WebAssembly.Module
          ? source
          : new WebAssembly.Module(source),
        imports
      )
    )
  }

  var instantiateSync_1 = instantiateSync;

  /** Asynchronously instantiates an AssemblyScript module from a response, i.e. as obtained by `fetch`. */
  async function instantiateStreaming(source, imports) {
    if (!WebAssembly.instantiateStreaming) {
      return instantiate(
        isResponse(source = await source)
          ? source.arrayBuffer()
          : source,
        imports
      );
    }
    return postInstantiate(
      preInstantiate(imports || (imports = {})),
      (await WebAssembly.instantiateStreaming(source, imports)).instance
    );
  }

  var instantiateStreaming_1 = instantiateStreaming;

  /** Demangles an AssemblyScript module's exports to a friendly object structure. */
  function demangle(exports, baseModule) {
    var module = baseModule ? Object.create(baseModule) : {};
    var setargc = exports["__setargc"] || function() {};
    function hasOwnProperty(elem, prop) {
      return Object.prototype.hasOwnProperty.call(elem, prop);
    }
    for (let internalName in exports) {
      if (!hasOwnProperty(exports, internalName)) continue;
      let elem = exports[internalName];
      let parts = internalName.split(".");
      let curr = module;
      while (parts.length > 1) {
        let part = parts.shift();
        if (!hasOwnProperty(curr, part)) curr[part] = {};
        curr = curr[part];
      }
      let name = parts[0];
      let hash = name.indexOf("#");
      if (hash >= 0) {
        let className = name.substring(0, hash);
        let classElem = curr[className];
        if (typeof classElem === "undefined" || !classElem.prototype) {
          let ctor = function(...args) {
            return ctor.wrap(ctor.prototype.constructor(0, ...args));
          };
          ctor.prototype = {
            valueOf: function valueOf() {
              return this[THIS];
            }
          };
          ctor.wrap = function(thisValue) {
            return Object.create(ctor.prototype, { [THIS]: { value: thisValue, writable: false } });
          };
          if (classElem) Object.getOwnPropertyNames(classElem).forEach(name =>
            Object.defineProperty(ctor, name, Object.getOwnPropertyDescriptor(classElem, name))
          );
          curr[className] = ctor;
        }
        name = name.substring(hash + 1);
        curr = curr[className].prototype;
        if (/^(get|set):/.test(name)) {
          if (!hasOwnProperty(curr, name = name.substring(4))) {
            let getter = exports[internalName.replace("set:", "get:")];
            let setter = exports[internalName.replace("get:", "set:")];
            Object.defineProperty(curr, name, {
              get: function() { return getter(this[THIS]); },
              set: function(value) { setter(this[THIS], value); },
              enumerable: true
            });
          }
        } else {
          if (name === 'constructor') {
            curr[name] = wrapFunction(elem, setargc);
          } else { // for methods
            Object.defineProperty(curr, name, {
              value: function (...args) {
                setargc(args.length);
                return elem(this[THIS], ...args);
              }
            });
          }
        }
      } else {
        if (/^(get|set):/.test(name)) {
          if (!hasOwnProperty(curr, name = name.substring(4))) {
            Object.defineProperty(curr, name, {
              get: exports[internalName.replace("set:", "get:")],
              set: exports[internalName.replace("get:", "set:")],
              enumerable: true
            });
          }
        } else if (typeof elem === "function") {
          curr[name] = wrapFunction(elem, setargc);
        } else {
          curr[name] = elem;
        }
      }
    }

    return module;
  }

  var demangle_1 = demangle;

  var loader = {
  	instantiate: instantiate_1,
  	instantiateSync: instantiateSync_1,
  	instantiateStreaming: instantiateStreaming_1,
  	demangle: demangle_1
  };

  function commonjsRequire () {
  	throw new Error('Dynamic requires are not currently supported by rollup-plugin-commonjs');
  }

  function unwrapExports (x) {
  	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
  }

  function createCommonjsModule(fn, module) {
  	return module = { exports: {} }, fn(module, module.exports), module.exports;
  }

  var dasm = createCommonjsModule(function (module) {
  var DASM = function(DASM) {
    DASM = DASM || {};
    var Module = DASM;

  var Module;
  if (typeof Module === "undefined") Module = {};
  if (!Module.expectedDataFileDownloads) {
   Module.expectedDataFileDownloads = 0;
   Module.finishedDataFileDownloads = 0;
  }
  Module.expectedDataFileDownloads++;
  ((function() {
   var loadPackage = (function(metadata) {
    function runWithFS() {
     Module["FS_createPath"]("/", "machines", true, true);
     Module["FS_createPath"]("/machines", "atari2600", true, true);
     Module["FS_createPath"]("/machines", "channel-f", true, true);
     var fileData0 = [];
     fileData0.push.apply(fileData0, [ 59, 32, 77, 65, 67, 82, 79, 46, 72, 10, 59, 32, 86, 101, 114, 115, 105, 111, 110, 32, 49, 46, 48, 54, 44, 32, 51, 47, 83, 69, 80, 84, 69, 77, 66, 69, 82, 47, 50, 48, 48, 52, 10, 10, 86, 69, 82, 83, 73, 79, 78, 95, 77, 65, 67, 82, 79, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 49, 48, 54, 10, 10, 59, 10, 59, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 32, 73, 83, 32, 69, 88, 80, 76, 73, 67, 73, 84, 76, 89, 32, 83, 85, 80, 80, 79, 82, 84, 69, 68, 32, 65, 83, 32, 65, 32, 68, 65, 83, 77, 45, 80, 82, 69, 70, 69, 82, 82, 69, 68, 32, 67, 79, 77, 80, 65, 78, 73, 79, 78, 32, 70, 73, 76, 69, 10, 59, 32, 80, 76, 69, 65, 83, 69, 32, 68, 79, 32, 42, 78, 79, 84, 42, 32, 82, 69, 68, 73, 83, 84, 82, 73, 66, 85, 84, 69, 32, 77, 79, 68, 73, 70, 73, 69, 68, 32, 86, 69, 82, 83, 73, 79, 78, 83, 32, 79, 70, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 33, 10, 59, 10, 59, 32, 84, 104, 105, 115, 32, 102, 105, 108, 101, 32, 100, 101, 102, 105, 110, 101, 115, 32, 68, 65, 83, 77, 32, 109, 97, 99, 114, 111, 115, 32, 117, 115, 101, 102, 117, 108, 32, 102, 111, 114, 32, 100, 101, 118, 101, 108, 111, 112, 109, 101, 110, 116, 32, 102, 111, 114, 32, 116, 104, 101, 32, 65, 116, 97, 114, 105, 32, 50, 54, 48, 48, 46, 10, 59, 32, 73, 116, 32, 105, 115, 32, 100, 105, 115, 116, 114, 105, 98, 117, 116, 101, 100, 32, 97, 115, 32, 97, 32, 99, 111, 109, 112, 97, 110, 105, 111, 110, 32, 109, 97, 99, 104, 105, 110, 101, 45, 115, 112, 101, 99, 105, 102, 105, 99, 32, 115, 117, 112, 112, 111, 114, 116, 32, 112, 97, 99, 107, 97, 103, 101, 10, 59, 32, 102, 111, 114, 32, 116, 104, 101, 32, 68, 65, 83, 77, 32, 99, 111, 109, 112, 105, 108, 101, 114, 46, 32, 85, 112, 100, 97, 116, 101, 115, 32, 116, 111, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 68, 65, 83, 77, 44, 32, 97, 110, 100, 32, 97, 115, 115, 111, 99, 105, 97, 116, 101, 100, 32, 116, 111, 111, 108, 115, 32, 97, 114, 101, 10, 59, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 32, 97, 116, 32, 97, 116, 32, 104, 116, 116, 112, 58, 47, 47, 119, 119, 119, 46, 97, 116, 97, 114, 105, 50, 54, 48, 48, 46, 111, 114, 103, 47, 100, 97, 115, 109, 10, 59, 10, 59, 32, 77, 97, 110, 121, 32, 116, 104, 97, 110, 107, 115, 32, 116, 111, 32, 116, 104, 101, 32, 112, 101, 111, 112, 108, 101, 32, 119, 104, 111, 32, 104, 97, 118, 101, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 100, 46, 32, 32, 73, 102, 32, 121, 111, 117, 32, 116, 97, 107, 101, 32, 105, 115, 115, 117, 101, 32, 119, 105, 116, 104, 32, 116, 104, 101, 10, 59, 32, 99, 111, 110, 116, 101, 110, 116, 115, 44, 32, 111, 114, 32, 119, 111, 117, 108, 100, 32, 108, 105, 107, 101, 32, 116, 111, 32, 97, 100, 100, 32, 115, 111, 109, 101, 116, 104, 105, 110, 103, 44, 32, 112, 108, 101, 97, 115, 101, 32, 119, 114, 105, 116, 101, 32, 116, 111, 32, 109, 101, 10, 59, 32, 40, 97, 116, 97, 114, 105, 50, 54, 48, 48, 64, 116, 97, 115, 119, 101, 103, 105, 97, 110, 46, 99, 111, 109, 41, 32, 119, 105, 116, 104, 32, 121, 111, 117, 114, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 105, 111, 110, 46, 10, 59, 10, 59, 32, 76, 97, 116, 101, 115, 116, 32, 82, 101, 118, 105, 115, 105, 111, 110, 115, 46, 46, 46, 10, 59, 10, 59, 32, 49, 46, 48, 54, 32, 32, 48, 51, 47, 83, 69, 80, 47, 50, 48, 48, 52, 32, 32, 32, 32, 32, 45, 32, 110, 105, 99, 101, 32, 114, 101, 118, 105, 115, 105, 111, 110, 32, 111, 102, 32, 86, 69, 82, 84, 73, 67, 65, 76, 95, 66, 76, 65, 78, 75, 32, 40, 69, 100, 119, 105, 110, 32, 66, 108, 105, 110, 107, 41, 10, 59, 32, 49, 46, 48, 53, 32, 32, 49, 52, 47, 78, 79, 86, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 45, 32, 65, 100, 100, 101, 100, 32, 86, 69, 82, 83, 73, 79, 78, 95, 77, 65, 67, 82, 79, 32, 101, 113, 117, 97, 116, 101, 32, 40, 119, 104, 105, 99, 104, 32, 119, 105, 108, 108, 32, 114, 101, 102, 108, 101, 99, 116, 32, 49, 48, 48, 120, 32, 118, 101, 114, 115, 105, 111, 110, 32, 35, 41, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 84, 104, 105, 115, 32, 119, 105, 108, 108, 32, 97, 108, 108, 111, 119, 32, 99, 111, 110, 100, 105, 116, 105, 111, 110, 97, 108, 32, 99, 111, 100, 101, 32, 116, 111, 32, 118, 101, 114, 105, 102, 121, 32, 77, 65, 67, 82, 79, 46, 72, 32, 98, 101, 105, 110, 103, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 117, 115, 101, 100, 32, 102, 111, 114, 32, 99, 111, 100, 101, 32, 97, 115, 115, 101, 109, 98, 108, 121, 46, 10, 59, 32, 49, 46, 48, 52, 32, 32, 49, 51, 47, 78, 79, 86, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 45, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 32, 109, 97, 99, 114, 111, 32, 97, 100, 100, 101, 100, 32, 40, 49, 54, 45, 98, 105, 116, 32, 97, 100, 100, 114, 101, 115, 115, 32, 108, 111, 97, 100, 41, 10, 59, 10, 59, 32, 49, 46, 48, 51, 32, 32, 50, 51, 47, 74, 85, 78, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 45, 32, 67, 76, 69, 65, 78, 95, 83, 84, 65, 82, 84, 32, 109, 97, 99, 114, 111, 32, 97, 100, 100, 101, 100, 32, 45, 32, 99, 108, 101, 97, 114, 115, 32, 84, 73, 65, 44, 32, 82, 65, 77, 44, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 10, 59, 10, 59, 32, 49, 46, 48, 50, 32, 32, 49, 52, 47, 74, 85, 78, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 45, 32, 86, 69, 82, 84, 73, 67, 65, 76, 95, 83, 89, 78, 67, 32, 109, 97, 99, 114, 111, 32, 97, 100, 100, 101, 100, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 40, 115, 116, 97, 110, 100, 97, 114, 100, 105, 115, 101, 100, 32, 109, 97, 99, 114, 111, 32, 102, 111, 114, 32, 118, 101, 114, 116, 105, 99, 97, 108, 32, 115, 121, 110, 99, 104, 32, 99, 111, 100, 101, 41, 10, 59, 32, 49, 46, 48, 49, 32, 32, 50, 50, 47, 77, 65, 82, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 45, 32, 83, 76, 69, 69, 80, 32, 109, 97, 99, 114, 111, 32, 97, 100, 100, 101, 100, 46, 32, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 78, 79, 95, 73, 76, 76, 69, 71, 65, 76, 95, 79, 80, 67, 79, 68, 69, 83, 32, 115, 119, 105, 116, 99, 104, 32, 105, 109, 112, 108, 101, 109, 101, 110, 116, 101, 100, 10, 59, 32, 49, 46, 48, 9, 50, 50, 47, 77, 65, 82, 47, 50, 48, 48, 51, 9, 9, 73, 110, 105, 116, 105, 97, 108, 32, 114, 101, 108, 101, 97, 115, 101, 10, 10, 59, 32, 78, 111, 116, 101, 58, 32, 84, 104, 101, 115, 101, 32, 109, 97, 99, 114, 111, 115, 32, 117, 115, 101, 32, 105, 108, 108, 101, 103, 97, 108, 32, 111, 112, 99, 111, 100, 101, 115, 46, 32, 32, 84, 111, 32, 100, 105, 115, 97, 98, 108, 101, 32, 105, 108, 108, 101, 103, 97, 108, 32, 111, 112, 99, 111, 100, 101, 32, 117, 115, 97, 103, 101, 44, 32, 10, 59, 32, 32, 32, 100, 101, 102, 105, 110, 101, 32, 116, 104, 101, 32, 115, 121, 109, 98, 111, 108, 32, 78, 79, 95, 73, 76, 76, 69, 71, 65, 76, 95, 79, 80, 67, 79, 68, 69, 83, 32, 40, 45, 68, 78, 79, 95, 73, 76, 76, 69, 71, 65, 76, 95, 79, 80, 67, 79, 68, 69, 83, 61, 49, 32, 111, 110, 32, 99, 111, 109, 109, 97, 110, 100, 45, 108, 105, 110, 101, 41, 46, 10, 59, 32, 32, 32, 73, 102, 32, 121, 111, 117, 32, 100, 111, 32, 110, 111, 116, 32, 97, 108, 108, 111, 119, 32, 105, 108, 108, 101, 103, 97, 108, 32, 111, 112, 99, 111, 100, 101, 32, 117, 115, 97, 103, 101, 44, 32, 121, 111, 117, 32, 109, 117, 115, 116, 32, 105, 110, 99, 108, 117, 100, 101, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 32, 10, 59, 32, 32, 32, 42, 97, 102, 116, 101, 114, 42, 32, 105, 110, 99, 108, 117, 100, 105, 110, 103, 32, 86, 67, 83, 46, 72, 32, 40, 97, 115, 32, 116, 104, 101, 32, 110, 111, 110, 45, 105, 108, 108, 101, 103, 97, 108, 32, 111, 112, 99, 111, 100, 101, 115, 32, 97, 99, 99, 101, 115, 115, 32, 104, 97, 114, 100, 119, 97, 114, 101, 10, 59, 32, 32, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 97, 110, 100, 32, 114, 101, 113, 117, 105, 114, 101, 32, 116, 104, 101, 109, 32, 116, 111, 32, 98, 101, 32, 100, 101, 102, 105, 110, 101, 100, 32, 102, 105, 114, 115, 116, 41, 46, 10, 10, 59, 32, 65, 118, 97, 105, 108, 97, 98, 108, 101, 32, 109, 97, 99, 114, 111, 115, 46, 46, 46, 10, 59, 32, 32, 32, 83, 76, 69, 69, 80, 32, 110, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 115, 108, 101, 101, 112, 32, 102, 111, 114, 32, 110, 32, 99, 121, 99, 108, 101, 115, 10, 59, 32, 32, 32, 86, 69, 82, 84, 73, 67, 65, 76, 95, 83, 89, 78, 67, 32, 32, 32, 32, 32, 32, 32, 45, 32, 99, 111, 114, 114, 101, 99, 116, 32, 51, 32, 115, 99, 97, 110, 108, 105, 110, 101, 32, 118, 101, 114, 116, 105, 99, 97, 108, 32, 115, 121, 110, 99, 104, 32, 99, 111, 100, 101, 10, 59, 32, 32, 32, 67, 76, 69, 65, 78, 95, 83, 84, 65, 82, 84, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 115, 101, 116, 32, 109, 97, 99, 104, 105, 110, 101, 32, 116, 111, 32, 107, 110, 111, 119, 110, 32, 115, 116, 97, 116, 101, 32, 111, 110, 32, 115, 116, 97, 114, 116, 117, 112, 10, 59, 32, 32, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 108, 111, 97, 100, 32, 97, 32, 49, 54, 45, 98, 105, 116, 32, 97, 98, 115, 111, 108, 117, 116, 101, 32, 116, 111, 32, 97, 32, 49, 54, 45, 98, 105, 116, 32, 118, 97, 114, 105, 97, 98, 108, 101, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 83, 76, 69, 69, 80, 32, 100, 117, 114, 97, 116, 105, 111, 110, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 58, 32, 84, 104, 111, 109, 97, 115, 32, 74, 101, 110, 116, 122, 115, 99, 104, 10, 59, 32, 73, 110, 115, 101, 114, 116, 115, 32, 99, 111, 100, 101, 32, 119, 104, 105, 99, 104, 32, 116, 97, 107, 101, 115, 32, 116, 104, 101, 32, 115, 112, 101, 99, 105, 102, 105, 101, 100, 32, 110, 117, 109, 98, 101, 114, 32, 111, 102, 32, 99, 121, 99, 108, 101, 115, 32, 116, 111, 32, 101, 120, 101, 99, 117, 116, 101, 46, 32, 32, 84, 104, 105, 115, 32, 105, 115, 10, 59, 32, 117, 115, 101, 102, 117, 108, 32, 102, 111, 114, 32, 99, 111, 100, 101, 32, 119, 104, 101, 114, 101, 32, 112, 114, 101, 99, 105, 115, 101, 32, 116, 105, 109, 105, 110, 103, 32, 105, 115, 32, 114, 101, 113, 117, 105, 114, 101, 100, 46, 10, 59, 32, 73, 76, 76, 69, 71, 65, 76, 45, 79, 80, 67, 79, 68, 69, 32, 86, 69, 82, 83, 73, 79, 78, 32, 68, 79, 69, 83, 32, 78, 79, 84, 32, 65, 70, 70, 69, 67, 84, 32, 70, 76, 65, 71, 83, 32, 79, 82, 32, 82, 69, 71, 73, 83, 84, 69, 82, 83, 46, 10, 59, 32, 76, 69, 71, 65, 76, 32, 79, 80, 67, 79, 68, 69, 32, 86, 69, 82, 83, 73, 79, 78, 32, 77, 65, 89, 32, 65, 70, 70, 69, 67, 84, 32, 70, 76, 65, 71, 83, 10, 59, 32, 85, 115, 101, 115, 32, 105, 108, 108, 101, 103, 97, 108, 32, 111, 112, 99, 111, 100, 101, 32, 40, 68, 65, 83, 77, 32, 50, 46, 50, 48, 46, 48, 49, 32, 111, 110, 119, 97, 114, 100, 115, 41, 46, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 65, 67, 32, 83, 76, 69, 69, 80, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 117, 115, 97, 103, 101, 58, 32, 83, 76, 69, 69, 80, 32, 110, 32, 40, 110, 62, 49, 41, 10, 46, 67, 89, 67, 76, 69, 83, 32, 32, 32, 32, 32, 83, 69, 84, 32, 123, 49, 125, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 73, 70, 32, 46, 67, 89, 67, 76, 69, 83, 32, 60, 32, 50, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 67, 72, 79, 32, 34, 77, 65, 67, 82, 79, 32, 69, 82, 82, 79, 82, 58, 32, 39, 83, 76, 69, 69, 80, 39, 58, 32, 68, 117, 114, 97, 116, 105, 111, 110, 32, 109, 117, 115, 116, 32, 98, 101, 32, 62, 32, 49, 34, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 82, 82, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 73, 70, 32, 46, 67, 89, 67, 76, 69, 83, 32, 38, 32, 49, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 73, 70, 78, 67, 79, 78, 83, 84, 32, 78, 79, 95, 73, 76, 76, 69, 71, 65, 76, 95, 79, 80, 67, 79, 68, 69, 83, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 110, 111, 112, 32, 48, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 76, 83, 69, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 98, 105, 116, 32, 86, 83, 89, 78, 67, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 46, 67, 89, 67, 76, 69, 83, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 83, 69, 84, 32, 46, 67, 89, 67, 76, 69, 83, 32, 45, 32, 51, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 82, 69, 80, 69, 65, 84, 32, 46, 67, 89, 67, 76, 69, 83, 32, 47, 32, 50, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 110, 111, 112, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 82, 69, 80, 69, 78, 68, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 77, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 86, 69, 82, 84, 73, 67, 65, 76, 95, 83, 89, 78, 67, 10, 59, 32, 114, 101, 118, 105, 115, 101, 100, 32, 118, 101, 114, 115, 105, 111, 110, 32, 98, 121, 32, 69, 100, 119, 105, 110, 32, 66, 108, 105, 110, 107, 32, 45, 45, 32, 115, 97, 118, 101, 115, 32, 98, 121, 116, 101, 115, 33, 10, 59, 32, 73, 110, 115, 101, 114, 116, 115, 32, 116, 104, 101, 32, 99, 111, 100, 101, 32, 114, 101, 113, 117, 105, 114, 101, 100, 32, 102, 111, 114, 32, 97, 32, 112, 114, 111, 112, 101, 114, 32, 51, 32, 115, 99, 97, 110, 108, 105, 110, 101, 32, 118, 101, 114, 116, 105, 99, 97, 108, 32, 115, 121, 110, 99, 32, 115, 101, 113, 117, 101, 110, 99, 101, 10, 59, 32, 78, 111, 116, 101, 58, 32, 65, 108, 116, 101, 114, 115, 32, 116, 104, 101, 32, 97, 99, 99, 117, 109, 117, 108, 97, 116, 111, 114, 10, 10, 59, 32, 79, 85, 84, 58, 32, 65, 32, 61, 32, 48, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 65, 67, 32, 86, 69, 82, 84, 73, 67, 65, 76, 95, 83, 89, 78, 67, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 108, 100, 97, 32, 35, 37, 49, 49, 49, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 101, 97, 99, 104, 32, 39, 49, 39, 32, 98, 105, 116, 115, 32, 103, 101, 110, 101, 114, 97, 116, 101, 32, 97, 32, 86, 83, 89, 78, 67, 32, 79, 78, 32, 108, 105, 110, 101, 32, 40, 98, 105, 116, 115, 32, 49, 46, 46, 51, 41, 10, 46, 86, 83, 76, 80, 49, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 115, 116, 97, 32, 87, 83, 89, 78, 67, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 49, 115, 116, 32, 39, 48, 39, 32, 98, 105, 116, 32, 114, 101, 115, 101, 116, 115, 32, 86, 115, 121, 110, 99, 44, 32, 50, 110, 100, 32, 39, 48, 39, 32, 98, 105, 116, 32, 101, 120, 105, 116, 32, 108, 111, 111, 112, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 115, 116, 97, 32, 86, 83, 89, 78, 67, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 108, 115, 114, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 98, 110, 101, 32, 46, 86, 83, 76, 80, 49, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 98, 114, 97, 110, 99, 104, 32, 117, 110, 116, 105, 108, 32, 86, 89, 83, 78, 67, 32, 104, 97, 115, 32, 98, 101, 101, 110, 32, 114, 101, 115, 101, 116, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 77, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 67, 76, 69, 65, 78, 95, 83, 84, 65, 82, 84, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 58, 32, 65, 110, 100, 114, 101, 119, 32, 68, 97, 118, 105, 101, 10, 59, 32, 83, 116, 97, 110, 100, 97, 114, 100, 105, 115, 101, 100, 32, 115, 116, 97, 114, 116, 45, 117, 112, 32, 99, 111, 100, 101, 44, 32, 99, 108, 101, 97, 114, 115, 32, 115, 116, 97, 99, 107, 44, 32, 97, 108, 108, 32, 84, 73, 65, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 97, 110, 100, 32, 82, 65, 77, 32, 116, 111, 32, 48, 10, 59, 32, 83, 101, 116, 115, 32, 115, 116, 97, 99, 107, 32, 112, 111, 105, 110, 116, 101, 114, 32, 116, 111, 32, 36, 70, 70, 44, 32, 97, 110, 100, 32, 97, 108, 108, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 116, 111, 32, 48, 10, 59, 32, 83, 101, 116, 115, 32, 100, 101, 99, 105, 109, 97, 108, 32, 109, 111, 100, 101, 32, 111, 102, 102, 44, 32, 115, 101, 116, 115, 32, 105, 110, 116, 101, 114, 114, 117, 112, 116, 32, 102, 108, 97, 103, 32, 40, 107, 105, 110, 100, 32, 111, 102, 32, 117, 110, 45, 110, 101, 99, 101, 115, 115, 97, 114, 121, 41, 10, 59, 32, 85, 115, 101, 32, 97, 115, 32, 118, 101, 114, 121, 32, 102, 105, 114, 115, 116, 32, 115, 101, 99, 116, 105, 111, 110, 32, 111, 102, 32, 99, 111, 100, 101, 32, 111, 110, 32, 98, 111, 111, 116, 32, 40, 105, 101, 58, 32, 97, 116, 32, 114, 101, 115, 101, 116, 41, 10, 59, 32, 67, 111, 100, 101, 32, 119, 114, 105, 116, 116, 101, 110, 32, 116, 111, 32, 109, 105, 110, 105, 109, 105, 115, 101, 32, 116, 111, 116, 97, 108, 32, 82, 79, 77, 32, 117, 115, 97, 103, 101, 32, 45, 32, 117, 115, 101, 115, 32, 119, 101, 105, 114, 100, 32, 54, 53, 48, 50, 32, 107, 110, 111, 119, 108, 101, 100, 103, 101, 32, 58, 41, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 65, 67, 32, 67, 76, 69, 65, 78, 95, 83, 84, 65, 82, 84, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 115, 101, 105, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 99, 108, 100, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 108, 100, 120, 32, 35, 48, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 116, 120, 97, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 116, 97, 121, 10, 46, 67, 76, 69, 65, 82, 95, 83, 84, 65, 67, 75, 32, 32, 32, 32, 100, 101, 120, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 116, 120, 115, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 112, 104, 97, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 98, 110, 101, 32, 46, 67, 76, 69, 65, 82, 95, 83, 84, 65, 67, 75, 32, 32, 32, 32, 32, 59, 32, 83, 80, 61, 36, 70, 70, 44, 32, 88, 32, 61, 32, 65, 32, 61, 32, 89, 32, 61, 32, 48, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 77, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 58, 32, 77, 97, 110, 117, 101, 108, 32, 82, 111, 116, 115, 99, 104, 107, 97, 114, 10, 59, 10, 59, 32, 83, 101, 116, 115, 32, 97, 32, 50, 32, 98, 121, 116, 101, 32, 82, 65, 77, 32, 112, 111, 105, 110, 116, 101, 114, 32, 116, 111, 32, 97, 110, 32, 97, 98, 115, 111, 108, 117, 116, 101, 32, 97, 100, 100, 114, 101, 115, 115, 46, 10, 59, 10, 59, 32, 85, 115, 97, 103, 101, 58, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 32, 112, 111, 105, 110, 116, 101, 114, 44, 32, 97, 100, 100, 114, 101, 115, 115, 10, 59, 32, 69, 120, 97, 109, 112, 108, 101, 58, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 32, 83, 112, 114, 105, 116, 101, 80, 84, 82, 44, 32, 83, 112, 114, 105, 116, 101, 68, 97, 116, 97, 10, 59, 10, 59, 32, 78, 111, 116, 101, 58, 32, 65, 108, 116, 101, 114, 115, 32, 116, 104, 101, 32, 97, 99, 99, 117, 109, 117, 108, 97, 116, 111, 114, 44, 32, 78, 90, 32, 102, 108, 97, 103, 115, 10, 59, 32, 73, 78, 32, 49, 58, 32, 50, 32, 98, 121, 116, 101, 32, 82, 65, 77, 32, 108, 111, 99, 97, 116, 105, 111, 110, 32, 114, 101, 115, 101, 114, 118, 101, 100, 32, 102, 111, 114, 32, 112, 111, 105, 110, 116, 101, 114, 10, 59, 32, 73, 78, 32, 50, 58, 32, 97, 98, 115, 111, 108, 117, 116, 101, 32, 97, 100, 100, 114, 101, 115, 115, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 65, 67, 32, 83, 69, 84, 95, 80, 79, 73, 78, 84, 69, 82, 10, 46, 80, 79, 73, 78, 84, 69, 82, 32, 32, 32, 32, 83, 69, 84, 32, 123, 49, 125, 10, 46, 65, 68, 68, 82, 69, 83, 83, 32, 32, 32, 32, 83, 69, 84, 32, 123, 50, 125, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 68, 65, 32, 35, 60, 46, 65, 68, 68, 82, 69, 83, 83, 32, 32, 59, 32, 71, 101, 116, 32, 76, 111, 119, 98, 121, 116, 101, 32, 111, 102, 32, 65, 100, 100, 114, 101, 115, 115, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 83, 84, 65, 32, 46, 80, 79, 73, 78, 84, 69, 82, 32, 32, 32, 32, 59, 32, 83, 116, 111, 114, 101, 32, 105, 110, 32, 112, 111, 105, 110, 116, 101, 114, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 68, 65, 32, 35, 62, 46, 65, 68, 68, 82, 69, 83, 83, 32, 32, 59, 32, 71, 101, 116, 32, 72, 105, 98, 121, 116, 101, 32, 111, 102, 32, 65, 100, 100, 114, 101, 115, 115, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 83, 84, 65, 32, 46, 80, 79, 73, 78, 84, 69, 82, 43, 49, 32, 32, 59, 32, 83, 116, 111, 114, 101, 32, 105, 110, 32, 112, 111, 105, 110, 116, 101, 114, 43, 49, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 77, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 66, 79, 85, 78, 68, 65, 82, 89, 32, 98, 121, 116, 101, 35, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 58, 32, 68, 101, 110, 105, 115, 32, 68, 101, 98, 114, 111, 32, 40, 98, 111, 114, 114, 111, 119, 101, 100, 32, 102, 114, 111, 109, 32, 66, 111, 98, 32, 83, 109, 105, 116, 104, 32, 47, 32, 84, 104, 111, 109, 97, 115, 41, 10, 59, 10, 59, 32, 80, 117, 115, 104, 32, 100, 97, 116, 97, 32, 116, 111, 32, 97, 32, 99, 101, 114, 116, 97, 105, 110, 32, 112, 111, 115, 105, 116, 105, 111, 110, 32, 105, 110, 115, 105, 100, 101, 32, 97, 32, 112, 97, 103, 101, 32, 97, 110, 100, 32, 107, 101, 101, 112, 32, 99, 111, 117, 110, 116, 32, 111, 102, 32, 104, 111, 119, 10, 59, 32, 109, 97, 110, 121, 32, 102, 114, 101, 101, 32, 98, 121, 116, 101, 115, 32, 116, 104, 101, 32, 112, 114, 111, 103, 114, 97, 109, 109, 101, 114, 32, 119, 105, 108, 108, 32, 104, 97, 118, 101, 46, 10, 59, 10, 59, 32, 101, 103, 58, 32, 66, 79, 85, 78, 68, 65, 82, 89, 32, 53, 32, 32, 32, 32, 59, 32, 112, 111, 115, 105, 116, 105, 111, 110, 32, 97, 116, 32, 98, 121, 116, 101, 32, 35, 53, 32, 105, 110, 32, 112, 97, 103, 101, 10, 10, 46, 70, 82, 69, 69, 95, 66, 89, 84, 69, 83, 32, 83, 69, 84, 32, 48, 32, 32, 32, 10, 32, 32, 32, 77, 65, 67, 32, 66, 79, 85, 78, 68, 65, 82, 89, 10, 32, 32, 32, 32, 32, 32, 82, 69, 80, 69, 65, 84, 32, 50, 53, 54, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 73, 70, 32, 60, 46, 32, 37, 32, 123, 49, 125, 32, 61, 32, 48, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 69, 88, 73, 84, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 76, 83, 69, 10, 46, 70, 82, 69, 69, 95, 66, 89, 84, 69, 83, 32, 83, 69, 84, 32, 46, 70, 82, 69, 69, 95, 66, 89, 84, 69, 83, 32, 43, 32, 49, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 46, 98, 121, 116, 101, 32, 36, 48, 48, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 32, 32, 32, 32, 32, 32, 82, 69, 80, 69, 78, 68, 10, 32, 32, 32, 69, 78, 68, 77, 10, 10, 10, 59, 32, 69, 79, 70, 10 ]);
     Module["FS_createDataFile"]("/machines/atari2600", "macro.h", fileData0, true, true, false);
     var fileData1 = [];
     fileData1.push.apply(fileData1, [ 59, 32, 86, 67, 83, 46, 72, 10, 59, 32, 86, 101, 114, 115, 105, 111, 110, 32, 49, 46, 48, 53, 44, 32, 49, 51, 47, 78, 111, 118, 101, 109, 98, 101, 114, 47, 50, 48, 48, 51, 10, 10, 86, 69, 82, 83, 73, 79, 78, 95, 86, 67, 83, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 49, 48, 53, 10, 10, 59, 32, 84, 72, 73, 83, 32, 73, 83, 32, 65, 32, 80, 82, 69, 76, 73, 77, 73, 78, 65, 82, 89, 32, 82, 69, 76, 69, 65, 83, 69, 32, 79, 70, 32, 42, 84, 72, 69, 42, 32, 34, 83, 84, 65, 78, 68, 65, 82, 68, 34, 32, 86, 67, 83, 46, 72, 10, 59, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 32, 73, 83, 32, 69, 88, 80, 76, 73, 67, 73, 84, 76, 89, 32, 83, 85, 80, 80, 79, 82, 84, 69, 68, 32, 65, 83, 32, 65, 32, 68, 65, 83, 77, 45, 80, 82, 69, 70, 69, 82, 82, 69, 68, 32, 67, 79, 77, 80, 65, 78, 73, 79, 78, 32, 70, 73, 76, 69, 10, 59, 32, 80, 76, 69, 65, 83, 69, 32, 68, 79, 32, 42, 78, 79, 84, 42, 32, 82, 69, 68, 73, 83, 84, 82, 73, 66, 85, 84, 69, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 33, 10, 59, 10, 59, 32, 84, 104, 105, 115, 32, 102, 105, 108, 101, 32, 100, 101, 102, 105, 110, 101, 115, 32, 104, 97, 114, 100, 119, 97, 114, 101, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 97, 110, 100, 32, 109, 101, 109, 111, 114, 121, 32, 109, 97, 112, 112, 105, 110, 103, 32, 102, 111, 114, 32, 116, 104, 101, 10, 59, 32, 65, 116, 97, 114, 105, 32, 50, 54, 48, 48, 46, 32, 73, 116, 32, 105, 115, 32, 100, 105, 115, 116, 114, 105, 98, 117, 116, 101, 100, 32, 97, 115, 32, 97, 32, 99, 111, 109, 112, 97, 110, 105, 111, 110, 32, 109, 97, 99, 104, 105, 110, 101, 45, 115, 112, 101, 99, 105, 102, 105, 99, 32, 115, 117, 112, 112, 111, 114, 116, 32, 112, 97, 99, 107, 97, 103, 101, 10, 59, 32, 102, 111, 114, 32, 116, 104, 101, 32, 68, 65, 83, 77, 32, 99, 111, 109, 112, 105, 108, 101, 114, 46, 32, 85, 112, 100, 97, 116, 101, 115, 32, 116, 111, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 68, 65, 83, 77, 44, 32, 97, 110, 100, 32, 97, 115, 115, 111, 99, 105, 97, 116, 101, 100, 32, 116, 111, 111, 108, 115, 32, 97, 114, 101, 10, 59, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 32, 97, 116, 32, 97, 116, 32, 104, 116, 116, 112, 58, 47, 47, 119, 119, 119, 46, 97, 116, 97, 114, 105, 50, 54, 48, 48, 46, 111, 114, 103, 47, 100, 97, 115, 109, 10, 59, 10, 59, 32, 77, 97, 110, 121, 32, 116, 104, 97, 110, 107, 115, 32, 116, 111, 32, 116, 104, 101, 32, 111, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 40, 115, 41, 32, 111, 102, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 97, 110, 100, 32, 116, 111, 32, 101, 118, 101, 114, 121, 111, 110, 101, 32, 119, 104, 111, 32, 104, 97, 115, 10, 59, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 100, 32, 116, 111, 32, 117, 110, 100, 101, 114, 115, 116, 97, 110, 100, 105, 110, 103, 32, 116, 104, 101, 32, 65, 116, 97, 114, 105, 32, 50, 54, 48, 48, 46, 32, 32, 73, 102, 32, 121, 111, 117, 32, 116, 97, 107, 101, 32, 105, 115, 115, 117, 101, 32, 119, 105, 116, 104, 32, 116, 104, 101, 10, 59, 32, 99, 111, 110, 116, 101, 110, 116, 115, 44, 32, 111, 114, 32, 110, 97, 109, 105, 110, 103, 32, 111, 102, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 44, 32, 112, 108, 101, 97, 115, 101, 32, 119, 114, 105, 116, 101, 32, 116, 111, 32, 109, 101, 32, 40, 97, 116, 97, 114, 105, 50, 54, 48, 48, 64, 116, 97, 115, 119, 101, 103, 105, 97, 110, 46, 99, 111, 109, 41, 10, 59, 32, 119, 105, 116, 104, 32, 121, 111, 117, 114, 32, 118, 105, 101, 119, 115, 46, 32, 32, 80, 108, 101, 97, 115, 101, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 44, 32, 105, 102, 32, 121, 111, 117, 32, 116, 104, 105, 110, 107, 32, 121, 111, 117, 32, 99, 97, 110, 32, 105, 109, 112, 114, 111, 118, 101, 32, 116, 104, 105, 115, 10, 59, 32, 102, 105, 108, 101, 33, 10, 59, 10, 59, 32, 76, 97, 116, 101, 115, 116, 32, 82, 101, 118, 105, 115, 105, 111, 110, 115, 46, 46, 46, 10, 59, 32, 49, 46, 48, 53, 32, 32, 49, 51, 47, 78, 79, 86, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 32, 45, 32, 67, 111, 114, 114, 101, 99, 116, 105, 111, 110, 32, 116, 111, 32, 49, 46, 48, 52, 32, 45, 32, 110, 111, 119, 32, 102, 117, 110, 99, 116, 105, 111, 110, 115, 32, 97, 115, 32, 114, 101, 113, 117, 101, 115, 116, 101, 100, 32, 98, 121, 32, 77, 82, 46, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 65, 100, 100, 101, 100, 32, 86, 69, 82, 83, 73, 79, 78, 95, 86, 67, 83, 32, 101, 113, 117, 97, 116, 101, 32, 40, 119, 104, 105, 99, 104, 32, 119, 105, 108, 108, 32, 114, 101, 102, 108, 101, 99, 116, 32, 49, 48, 48, 120, 32, 118, 101, 114, 115, 105, 111, 110, 32, 35, 41, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 84, 104, 105, 115, 32, 119, 105, 108, 108, 32, 97, 108, 108, 111, 119, 32, 99, 111, 110, 100, 105, 116, 105, 111, 110, 97, 108, 32, 99, 111, 100, 101, 32, 116, 111, 32, 118, 101, 114, 105, 102, 121, 32, 86, 67, 83, 46, 72, 32, 98, 101, 105, 110, 103, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 117, 115, 101, 100, 32, 102, 111, 114, 32, 99, 111, 100, 101, 32, 97, 115, 115, 101, 109, 98, 108, 121, 46, 10, 59, 32, 49, 46, 48, 52, 32, 32, 49, 50, 47, 78, 79, 86, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 65, 100, 100, 101, 100, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 87, 82, 73, 84, 69, 95, 65, 68, 68, 82, 69, 83, 83, 32, 97, 110, 100, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 82, 69, 65, 68, 95, 65, 68, 68, 82, 69, 83, 83, 32, 102, 111, 114, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 99, 111, 110, 118, 101, 110, 105, 101, 110, 116, 32, 100, 105, 115, 97, 115, 115, 101, 109, 98, 108, 121, 47, 114, 101, 97, 115, 115, 101, 109, 98, 108, 121, 32, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 32, 102, 111, 114, 32, 104, 97, 114, 100, 119, 97, 114, 101, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 109, 105, 114, 114, 111, 114, 101, 100, 32, 114, 101, 97, 100, 105, 110, 103, 47, 119, 114, 105, 116, 105, 110, 103, 32, 100, 105, 102, 102, 101, 114, 101, 110, 99, 101, 115, 46, 32, 32, 84, 104, 105, 115, 32, 105, 115, 32, 109, 111, 114, 101, 32, 97, 32, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 114, 101, 97, 100, 97, 98, 105, 108, 105, 116, 121, 32, 105, 115, 115, 117, 101, 44, 32, 97, 110, 100, 32, 98, 105, 110, 97, 114, 121, 32, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 32, 119, 105, 116, 104, 32, 100, 105, 115, 97, 115, 115, 101, 109, 98, 108, 101, 100, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 97, 110, 100, 32, 114, 101, 97, 115, 115, 101, 109, 98, 108, 101, 100, 32, 115, 111, 117, 114, 99, 101, 115, 46, 32, 32, 80, 101, 114, 32, 77, 97, 110, 117, 101, 108, 32, 82, 111, 116, 115, 99, 104, 107, 97, 114, 39, 115, 32, 115, 117, 103, 103, 101, 115, 116, 105, 111, 110, 46, 10, 59, 32, 49, 46, 48, 51, 32, 32, 49, 50, 47, 77, 65, 89, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 65, 100, 100, 101, 100, 32, 83, 69, 71, 32, 115, 101, 103, 109, 101, 110, 116, 32, 97, 116, 32, 101, 110, 100, 32, 111, 102, 32, 102, 105, 108, 101, 32, 116, 111, 32, 102, 105, 120, 32, 111, 108, 100, 45, 99, 111, 100, 101, 32, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 119, 104, 105, 99, 104, 32, 119, 97, 115, 32, 98, 114, 111, 107, 101, 110, 32, 98, 121, 32, 116, 104, 101, 32, 117, 115, 101, 32, 111, 102, 32, 115, 101, 103, 109, 101, 110, 116, 115, 32, 105, 110, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 97, 115, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 114, 101, 112, 111, 114, 116, 101, 100, 32, 98, 121, 32, 77, 97, 110, 117, 101, 108, 32, 80, 111, 108, 105, 107, 32, 111, 110, 32, 91, 115, 116, 101, 108, 108, 97, 93, 32, 49, 49, 47, 77, 65, 89, 47, 50, 48, 48, 51, 10, 59, 32, 49, 46, 48, 50, 32, 32, 50, 50, 47, 77, 65, 82, 47, 50, 48, 48, 51, 32, 32, 32, 32, 32, 65, 100, 100, 101, 100, 32, 84, 73, 77, 73, 78, 84, 40, 36, 50, 56, 53, 41, 10, 59, 32, 49, 46, 48, 49, 9, 32, 32, 32, 32, 32, 32, 32, 32, 9, 9, 67, 111, 110, 115, 116, 97, 110, 116, 32, 111, 102, 102, 115, 101, 116, 32, 97, 100, 100, 101, 100, 32, 116, 111, 32, 97, 108, 108, 111, 119, 32, 117, 115, 101, 32, 102, 111, 114, 32, 51, 70, 45, 115, 116, 121, 108, 101, 32, 98, 97, 110, 107, 115, 119, 105, 116, 99, 104, 105, 110, 103, 10, 59, 9, 9, 9, 9, 9, 9, 32, 45, 32, 100, 101, 102, 105, 110, 101, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 32, 97, 115, 32, 36, 52, 48, 32, 102, 111, 114, 32, 84, 105, 103, 101, 114, 118, 105, 115, 105, 111, 110, 32, 99, 97, 114, 116, 115, 44, 32, 111, 116, 104, 101, 114, 119, 105, 115, 101, 10, 59, 9, 9, 9, 9, 9, 9, 32, 32, 32, 105, 116, 32, 105, 115, 32, 115, 97, 102, 101, 32, 116, 111, 32, 108, 101, 97, 118, 101, 32, 105, 116, 32, 117, 110, 100, 101, 102, 105, 110, 101, 100, 44, 32, 97, 110, 100, 32, 116, 104, 101, 32, 98, 97, 115, 101, 32, 97, 100, 100, 114, 101, 115, 115, 32, 119, 105, 108, 108, 10, 59, 9, 9, 9, 9, 9, 9, 32, 32, 32, 98, 101, 32, 115, 101, 116, 32, 116, 111, 32, 48, 46, 32, 32, 84, 104, 97, 110, 107, 115, 32, 116, 111, 32, 69, 99, 107, 104, 97, 114, 100, 32, 83, 116, 111, 108, 98, 101, 114, 103, 32, 102, 111, 114, 32, 116, 104, 101, 32, 115, 117, 103, 103, 101, 115, 116, 105, 111, 110, 46, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 78, 111, 116, 101, 44, 32, 109, 97, 121, 32, 117, 115, 101, 32, 45, 68, 76, 65, 66, 69, 76, 61, 69, 88, 80, 82, 69, 83, 83, 73, 79, 78, 32, 116, 111, 32, 100, 101, 102, 105, 110, 101, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 32, 114, 101, 103, 105, 115, 116, 101, 114, 32, 100, 101, 102, 105, 110, 105, 116, 105, 111, 110, 115, 32, 97, 114, 101, 32, 110, 111, 119, 32, 103, 101, 110, 101, 114, 97, 116, 101, 100, 32, 116, 104, 114, 111, 117, 103, 104, 32, 97, 115, 115, 105, 103, 110, 109, 101, 110, 116, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 105, 110, 32, 117, 110, 105, 110, 105, 116, 105, 97, 108, 105, 115, 101, 100, 32, 115, 101, 103, 109, 101, 110, 116, 115, 46, 32, 32, 84, 104, 105, 115, 32, 97, 108, 108, 111, 119, 115, 32, 97, 32, 99, 104, 97, 110, 103, 101, 97, 98, 108, 101, 32, 98, 97, 115, 101, 10, 59, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 97, 100, 100, 114, 101, 115, 115, 32, 97, 114, 99, 104, 105, 116, 101, 99, 116, 117, 114, 101, 46, 10, 59, 32, 49, 46, 48, 9, 50, 50, 47, 77, 65, 82, 47, 50, 48, 48, 51, 9, 9, 73, 110, 105, 116, 105, 97, 108, 32, 114, 101, 108, 101, 97, 115, 101, 10, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 59, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 59, 32, 84, 104, 101, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 32, 100, 101, 102, 105, 110, 101, 115, 32, 116, 104, 101, 32, 98, 97, 115, 101, 32, 97, 100, 100, 114, 101, 115, 115, 32, 111, 102, 32, 97, 99, 99, 101, 115, 115, 32, 116, 111, 32, 84, 73, 65, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 46, 10, 59, 32, 78, 111, 114, 109, 97, 108, 108, 121, 32, 48, 44, 32, 116, 104, 101, 32, 98, 97, 115, 101, 32, 97, 100, 100, 114, 101, 115, 115, 32, 115, 104, 111, 117, 108, 100, 32, 40, 101, 120, 116, 101, 114, 110, 97, 108, 108, 121, 44, 32, 98, 101, 102, 111, 114, 101, 32, 105, 110, 99, 108, 117, 100, 105, 110, 103, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 41, 10, 59, 32, 98, 101, 32, 115, 101, 116, 32, 116, 111, 32, 36, 52, 48, 32, 119, 104, 101, 110, 32, 99, 114, 101, 97, 116, 105, 110, 103, 32, 51, 70, 45, 98, 97, 110, 107, 115, 119, 105, 116, 99, 104, 101, 100, 32, 40, 97, 110, 100, 32, 111, 116, 104, 101, 114, 63, 41, 32, 99, 97, 114, 116, 114, 105, 100, 103, 101, 115, 46, 10, 59, 32, 84, 104, 101, 32, 114, 101, 97, 115, 111, 110, 32, 105, 115, 32, 116, 104, 97, 116, 32, 116, 104, 105, 115, 32, 98, 97, 110, 107, 115, 119, 105, 116, 99, 104, 105, 110, 103, 32, 115, 99, 104, 101, 109, 101, 32, 116, 114, 101, 97, 116, 115, 32, 97, 110, 121, 32, 97, 99, 99, 101, 115, 115, 32, 116, 111, 32, 108, 111, 99, 97, 116, 105, 111, 110, 115, 10, 59, 32, 60, 32, 36, 52, 48, 32, 97, 115, 32, 97, 32, 98, 97, 110, 107, 115, 119, 105, 116, 99, 104, 46, 10, 10, 9, 9, 9, 73, 70, 78, 67, 79, 78, 83, 84, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 9, 61, 32, 48, 10, 9, 9, 9, 69, 78, 68, 73, 70, 10, 10, 59, 32, 78, 111, 116, 101, 58, 32, 84, 104, 101, 32, 97, 100, 100, 114, 101, 115, 115, 32, 109, 97, 121, 32, 98, 101, 32, 100, 101, 102, 105, 110, 101, 100, 32, 111, 110, 32, 116, 104, 101, 32, 99, 111, 109, 109, 97, 110, 100, 45, 108, 105, 110, 101, 32, 117, 115, 105, 110, 103, 32, 116, 104, 101, 32, 45, 68, 32, 115, 119, 105, 116, 99, 104, 44, 32, 101, 103, 58, 10, 59, 32, 100, 97, 115, 109, 46, 101, 120, 101, 32, 99, 111, 100, 101, 46, 97, 115, 109, 32, 45, 68, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 61, 36, 52, 48, 32, 45, 102, 51, 32, 45, 118, 53, 32, 45, 111, 99, 111, 100, 101, 46, 98, 105, 110, 10, 59, 32, 42, 79, 82, 42, 32, 98, 121, 32, 100, 101, 99, 108, 97, 114, 105, 110, 103, 32, 116, 104, 101, 32, 108, 97, 98, 101, 108, 32, 98, 101, 102, 111, 114, 101, 32, 105, 110, 99, 108, 117, 100, 105, 110, 103, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 101, 103, 58, 10, 59, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 32, 61, 32, 36, 52, 48, 10, 59, 32, 32, 32, 105, 110, 99, 108, 117, 100, 101, 32, 34, 118, 99, 115, 46, 104, 34, 10, 10, 59, 32, 65, 108, 116, 101, 114, 110, 97, 116, 101, 32, 114, 101, 97, 100, 47, 119, 114, 105, 116, 101, 32, 97, 100, 100, 114, 101, 115, 115, 32, 99, 97, 112, 97, 98, 105, 108, 105, 116, 121, 32, 45, 32, 97, 108, 108, 111, 119, 115, 32, 102, 111, 114, 32, 115, 111, 109, 101, 32, 100, 105, 115, 97, 115, 115, 101, 109, 98, 108, 121, 32, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 10, 59, 32, 117, 115, 97, 103, 101, 32, 59, 32, 116, 111, 32, 97, 108, 108, 111, 119, 32, 114, 101, 97, 115, 115, 101, 109, 98, 108, 121, 32, 116, 111, 32, 98, 105, 110, 97, 114, 121, 32, 112, 101, 114, 102, 101, 99, 116, 32, 99, 111, 112, 105, 101, 115, 41, 46, 32, 32, 84, 104, 105, 115, 32, 105, 115, 32, 101, 115, 115, 101, 110, 116, 105, 97, 108, 108, 121, 32, 99, 97, 116, 101, 114, 105, 110, 103, 10, 59, 32, 102, 111, 114, 32, 116, 104, 101, 32, 109, 105, 114, 114, 111, 114, 101, 100, 32, 82, 79, 77, 32, 104, 97, 114, 100, 119, 97, 114, 101, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 46, 10, 10, 59, 32, 85, 115, 97, 103, 101, 58, 32, 65, 115, 32, 112, 101, 114, 32, 97, 98, 111, 118, 101, 44, 32, 100, 101, 102, 105, 110, 101, 32, 116, 104, 101, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 82, 69, 65, 68, 95, 65, 68, 68, 82, 69, 83, 83, 32, 97, 110, 100, 47, 111, 114, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 87, 82, 73, 84, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 59, 32, 117, 115, 105, 110, 103, 32, 116, 104, 101, 32, 45, 68, 32, 99, 111, 109, 109, 97, 110, 100, 45, 108, 105, 110, 101, 32, 115, 119, 105, 116, 99, 104, 44, 32, 97, 115, 32, 114, 101, 113, 117, 105, 114, 101, 100, 46, 32, 32, 73, 102, 32, 116, 104, 101, 32, 97, 100, 100, 114, 101, 115, 115, 101, 115, 32, 97, 114, 101, 32, 110, 111, 116, 32, 100, 101, 102, 105, 110, 101, 100, 44, 32, 10, 59, 32, 116, 104, 101, 121, 32, 100, 101, 102, 97, 117, 116, 32, 116, 111, 32, 116, 104, 101, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 46, 10, 10, 32, 32, 32, 32, 32, 73, 70, 78, 67, 79, 78, 83, 84, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 82, 69, 65, 68, 95, 65, 68, 68, 82, 69, 83, 83, 10, 84, 73, 65, 95, 66, 65, 83, 69, 95, 82, 69, 65, 68, 95, 65, 68, 68, 82, 69, 83, 83, 32, 61, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 10, 32, 32, 32, 32, 32, 73, 70, 78, 67, 79, 78, 83, 84, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 87, 82, 73, 84, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 84, 73, 65, 95, 66, 65, 83, 69, 95, 87, 82, 73, 84, 69, 95, 65, 68, 68, 82, 69, 83, 83, 32, 61, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 32, 32, 32, 32, 32, 69, 78, 68, 73, 70, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 9, 9, 9, 83, 69, 71, 46, 85, 32, 84, 73, 65, 95, 82, 69, 71, 73, 83, 84, 69, 82, 83, 95, 87, 82, 73, 84, 69, 10, 9, 9, 9, 79, 82, 71, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 87, 82, 73, 84, 69, 95, 65, 68, 68, 82, 69, 83, 83, 10, 10, 9, 59, 32, 68, 79, 32, 78, 79, 84, 32, 67, 72, 65, 78, 71, 69, 32, 84, 72, 69, 32, 82, 69, 76, 65, 84, 73, 86, 69, 32, 79, 82, 68, 69, 82, 73, 78, 71, 32, 79, 70, 32, 82, 69, 71, 73, 83, 84, 69, 82, 83, 33, 10, 32, 32, 32, 32, 10, 86, 83, 89, 78, 67, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 48, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 86, 101, 114, 116, 105, 99, 97, 108, 32, 83, 121, 110, 99, 32, 83, 101, 116, 45, 67, 108, 101, 97, 114, 10, 86, 66, 76, 65, 78, 75, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 49, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 86, 101, 114, 116, 105, 99, 97, 108, 32, 66, 108, 97, 110, 107, 32, 83, 101, 116, 45, 67, 108, 101, 97, 114, 10, 87, 83, 89, 78, 67, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 50, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 87, 97, 105, 116, 32, 102, 111, 114, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 66, 108, 97, 110, 107, 10, 82, 83, 89, 78, 67, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 51, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 83, 121, 110, 99, 32, 67, 111, 117, 110, 116, 101, 114, 10, 78, 85, 83, 73, 90, 48, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 52, 32, 32, 32, 48, 48, 120, 120, 32, 48, 120, 120, 120, 32, 32, 32, 78, 117, 109, 98, 101, 114, 45, 83, 105, 122, 101, 32, 112, 108, 97, 121, 101, 114, 47, 109, 105, 115, 115, 108, 101, 32, 48, 10, 78, 85, 83, 73, 90, 49, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 53, 32, 32, 32, 48, 48, 120, 120, 32, 48, 120, 120, 120, 32, 32, 32, 78, 117, 109, 98, 101, 114, 45, 83, 105, 122, 101, 32, 112, 108, 97, 121, 101, 114, 47, 109, 105, 115, 115, 108, 101, 32, 49, 10, 67, 79, 76, 85, 80, 48, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 48, 54, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 48, 32, 32, 32, 67, 111, 108, 111, 114, 45, 76, 117, 109, 105, 110, 97, 110, 99, 101, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 67, 79, 76, 85, 80, 49, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 55, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 48, 32, 32, 32, 67, 111, 108, 111, 114, 45, 76, 117, 109, 105, 110, 97, 110, 99, 101, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 67, 79, 76, 85, 80, 70, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 56, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 48, 32, 32, 32, 67, 111, 108, 111, 114, 45, 76, 117, 109, 105, 110, 97, 110, 99, 101, 32, 80, 108, 97, 121, 102, 105, 101, 108, 100, 10, 67, 79, 76, 85, 66, 75, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 57, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 48, 32, 32, 32, 67, 111, 108, 111, 114, 45, 76, 117, 109, 105, 110, 97, 110, 99, 101, 32, 66, 97, 99, 107, 103, 114, 111, 117, 110, 100, 10, 67, 84, 82, 76, 80, 70, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 65, 32, 32, 32, 48, 48, 120, 120, 32, 48, 120, 120, 120, 32, 32, 32, 67, 111, 110, 116, 114, 111, 108, 32, 80, 108, 97, 121, 102, 105, 101, 108, 100, 44, 32, 66, 97, 108, 108, 44, 32, 67, 111, 108, 108, 105, 115, 105, 111, 110, 115, 10, 82, 69, 70, 80, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 66, 32, 32, 32, 48, 48, 48, 48, 32, 120, 48, 48, 48, 32, 32, 32, 82, 101, 102, 108, 101, 99, 116, 105, 111, 110, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 82, 69, 70, 80, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 67, 32, 32, 32, 48, 48, 48, 48, 32, 120, 48, 48, 48, 32, 32, 32, 82, 101, 102, 108, 101, 99, 116, 105, 111, 110, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 80, 70, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 68, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 80, 108, 97, 121, 102, 105, 101, 108, 100, 32, 82, 101, 103, 105, 115, 116, 101, 114, 32, 66, 121, 116, 101, 32, 48, 10, 80, 70, 49, 32, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 69, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 120, 32, 32, 32, 80, 108, 97, 121, 102, 105, 101, 108, 100, 32, 82, 101, 103, 105, 115, 116, 101, 114, 32, 66, 121, 116, 101, 32, 49, 10, 80, 70, 50, 32, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 70, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 120, 32, 32, 32, 80, 108, 97, 121, 102, 105, 101, 108, 100, 32, 82, 101, 103, 105, 115, 116, 101, 114, 32, 66, 121, 116, 101, 32, 50, 10, 82, 69, 83, 80, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 48, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 82, 69, 83, 80, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 49, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 82, 69, 83, 77, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 50, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 77, 105, 115, 115, 108, 101, 32, 48, 10, 82, 69, 83, 77, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 51, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 77, 105, 115, 115, 108, 101, 32, 49, 10, 82, 69, 83, 66, 76, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 52, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 82, 101, 115, 101, 116, 32, 66, 97, 108, 108, 10, 65, 85, 68, 67, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 53, 32, 32, 32, 48, 48, 48, 48, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 67, 111, 110, 116, 114, 111, 108, 32, 48, 10, 65, 85, 68, 67, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 54, 32, 32, 32, 48, 48, 48, 48, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 67, 111, 110, 116, 114, 111, 108, 32, 49, 10, 65, 85, 68, 70, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 55, 32, 32, 32, 48, 48, 48, 120, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 70, 114, 101, 113, 117, 101, 110, 99, 121, 32, 48, 10, 65, 85, 68, 70, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 56, 32, 32, 32, 48, 48, 48, 120, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 70, 114, 101, 113, 117, 101, 110, 99, 121, 32, 49, 10, 65, 85, 68, 86, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 57, 32, 32, 32, 48, 48, 48, 48, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 86, 111, 108, 117, 109, 101, 32, 48, 10, 65, 85, 68, 86, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 65, 32, 32, 32, 48, 48, 48, 48, 32, 120, 120, 120, 120, 32, 32, 32, 65, 117, 100, 105, 111, 32, 86, 111, 108, 117, 109, 101, 32, 49, 10, 71, 82, 80, 48, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 66, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 120, 32, 32, 32, 71, 114, 97, 112, 104, 105, 99, 115, 32, 82, 101, 103, 105, 115, 116, 101, 114, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 71, 82, 80, 49, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 67, 32, 32, 32, 120, 120, 120, 120, 32, 120, 120, 120, 120, 32, 32, 32, 71, 114, 97, 112, 104, 105, 99, 115, 32, 82, 101, 103, 105, 115, 116, 101, 114, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 69, 78, 65, 77, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 68, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 71, 114, 97, 112, 104, 105, 99, 115, 32, 69, 110, 97, 98, 108, 101, 32, 77, 105, 115, 115, 108, 101, 32, 48, 10, 69, 78, 65, 77, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 69, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 71, 114, 97, 112, 104, 105, 99, 115, 32, 69, 110, 97, 98, 108, 101, 32, 77, 105, 115, 115, 108, 101, 32, 49, 10, 69, 78, 65, 66, 76, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 49, 70, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 71, 114, 97, 112, 104, 105, 99, 115, 32, 69, 110, 97, 98, 108, 101, 32, 66, 97, 108, 108, 10, 72, 77, 80, 48, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 48, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 72, 77, 80, 49, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 49, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 72, 77, 77, 48, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 50, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 32, 77, 105, 115, 115, 108, 101, 32, 48, 10, 72, 77, 77, 49, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 51, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 32, 77, 105, 115, 115, 108, 101, 32, 49, 10, 72, 77, 66, 76, 32, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 52, 32, 32, 32, 120, 120, 120, 120, 32, 48, 48, 48, 48, 32, 32, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 32, 66, 97, 108, 108, 10, 86, 68, 69, 76, 80, 48, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 53, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 48, 120, 32, 32, 32, 86, 101, 114, 116, 105, 99, 97, 108, 32, 68, 101, 108, 97, 121, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 86, 68, 69, 76, 80, 49, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 54, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 48, 120, 32, 32, 32, 86, 101, 114, 116, 105, 99, 97, 108, 32, 68, 101, 108, 97, 121, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 86, 68, 69, 76, 66, 76, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 55, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 48, 120, 32, 32, 32, 86, 101, 114, 116, 105, 99, 97, 108, 32, 68, 101, 108, 97, 121, 32, 66, 97, 108, 108, 10, 82, 69, 83, 77, 80, 48, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 82, 101, 115, 101, 116, 32, 77, 105, 115, 115, 108, 101, 32, 48, 32, 116, 111, 32, 80, 108, 97, 121, 101, 114, 32, 48, 10, 82, 69, 83, 77, 80, 49, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 57, 32, 32, 32, 48, 48, 48, 48, 32, 48, 48, 120, 48, 32, 32, 32, 82, 101, 115, 101, 116, 32, 77, 105, 115, 115, 108, 101, 32, 49, 32, 116, 111, 32, 80, 108, 97, 121, 101, 114, 32, 49, 10, 72, 77, 79, 86, 69, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 65, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 65, 112, 112, 108, 121, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 116, 105, 111, 110, 10, 72, 77, 67, 76, 82, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 66, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 67, 108, 101, 97, 114, 32, 72, 111, 114, 105, 122, 111, 110, 116, 97, 108, 32, 77, 111, 118, 101, 32, 82, 101, 103, 105, 115, 116, 101, 114, 115, 10, 67, 88, 67, 76, 82, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 67, 32, 32, 32, 45, 45, 45, 45, 32, 45, 45, 45, 45, 32, 32, 32, 67, 108, 101, 97, 114, 32, 67, 111, 108, 108, 105, 115, 105, 111, 110, 32, 76, 97, 116, 99, 104, 101, 115, 10, 32, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 9, 9, 9, 83, 69, 71, 46, 85, 32, 84, 73, 65, 95, 82, 69, 71, 73, 83, 84, 69, 82, 83, 95, 82, 69, 65, 68, 10, 9, 9, 9, 79, 82, 71, 32, 84, 73, 65, 95, 66, 65, 83, 69, 95, 82, 69, 65, 68, 95, 65, 68, 68, 82, 69, 83, 83, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 98, 105, 116, 32, 55, 32, 32, 32, 98, 105, 116, 32, 54, 10, 67, 88, 77, 48, 80, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 48, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 67, 111, 108, 108, 105, 115, 105, 111, 110, 32, 32, 77, 48, 45, 80, 49, 32, 32, 32, 77, 48, 45, 80, 48, 10, 67, 88, 77, 49, 80, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 49, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 49, 45, 80, 48, 32, 32, 32, 77, 49, 45, 80, 49, 10, 67, 88, 80, 48, 70, 66, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 50, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 48, 45, 80, 70, 32, 32, 32, 80, 48, 45, 66, 76, 10, 67, 88, 80, 49, 70, 66, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 51, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 49, 45, 80, 70, 32, 32, 32, 80, 49, 45, 66, 76, 10, 67, 88, 77, 48, 70, 66, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 52, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 48, 45, 80, 70, 32, 32, 32, 77, 48, 45, 66, 76, 10, 67, 88, 77, 49, 70, 66, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 53, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 77, 49, 45, 80, 70, 32, 32, 32, 77, 49, 45, 66, 76, 10, 67, 88, 66, 76, 80, 70, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 54, 32, 32, 32, 32, 32, 32, 32, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 66, 76, 45, 80, 70, 32, 32, 32, 45, 45, 45, 45, 45, 10, 67, 88, 80, 80, 77, 77, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 55, 32, 32, 32, 32, 32, 32, 32, 120, 120, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 48, 45, 80, 49, 32, 32, 32, 77, 48, 45, 77, 49, 10, 73, 78, 80, 84, 48, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 56, 32, 32, 32, 32, 32, 32, 32, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 80, 111, 116, 32, 80, 111, 114, 116, 32, 48, 10, 73, 78, 80, 84, 49, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 57, 32, 32, 32, 32, 32, 32, 32, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 80, 111, 116, 32, 80, 111, 114, 116, 32, 49, 10, 73, 78, 80, 84, 50, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 65, 32, 32, 32, 32, 32, 32, 32, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 80, 111, 116, 32, 80, 111, 114, 116, 32, 50, 10, 73, 78, 80, 84, 51, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 66, 32, 32, 32, 32, 32, 32, 32, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 80, 111, 116, 32, 80, 111, 114, 116, 32, 51, 10, 73, 78, 80, 84, 52, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 48, 67, 9, 9, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 73, 110, 112, 117, 116, 32, 40, 84, 114, 105, 103, 103, 101, 114, 41, 32, 48, 10, 73, 78, 80, 84, 53, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 9, 59, 32, 36, 48, 68, 9, 9, 120, 48, 48, 48, 32, 48, 48, 48, 48, 32, 32, 32, 32, 32, 32, 32, 82, 101, 97, 100, 32, 73, 110, 112, 117, 116, 32, 40, 84, 114, 105, 103, 103, 101, 114, 41, 32, 49, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 9, 9, 9, 83, 69, 71, 46, 85, 32, 82, 73, 79, 84, 10, 9, 9, 9, 79, 82, 71, 32, 36, 50, 56, 48, 10, 32, 10, 9, 59, 32, 82, 73, 79, 84, 32, 77, 69, 77, 79, 82, 89, 32, 77, 65, 80, 10, 10, 83, 87, 67, 72, 65, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 48, 32, 32, 32, 32, 32, 32, 80, 111, 114, 116, 32, 65, 32, 100, 97, 116, 97, 32, 114, 101, 103, 105, 115, 116, 101, 114, 32, 102, 111, 114, 32, 106, 111, 121, 115, 116, 105, 99, 107, 115, 58, 10, 9, 9, 9, 9, 9, 59, 9, 9, 9, 66, 105, 116, 115, 32, 52, 45, 55, 32, 102, 111, 114, 32, 112, 108, 97, 121, 101, 114, 32, 49, 46, 32, 32, 66, 105, 116, 115, 32, 48, 45, 51, 32, 102, 111, 114, 32, 112, 108, 97, 121, 101, 114, 32, 50, 46, 10, 10, 83, 87, 65, 67, 78, 84, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 49, 32, 32, 32, 32, 32, 32, 80, 111, 114, 116, 32, 65, 32, 100, 97, 116, 97, 32, 100, 105, 114, 101, 99, 116, 105, 111, 110, 32, 114, 101, 103, 105, 115, 116, 101, 114, 32, 40, 68, 68, 82, 41, 10, 83, 87, 67, 72, 66, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 50, 9, 9, 80, 111, 114, 116, 32, 66, 32, 100, 97, 116, 97, 32, 40, 99, 111, 110, 115, 111, 108, 101, 32, 115, 119, 105, 116, 99, 104, 101, 115, 41, 10, 83, 87, 66, 67, 78, 84, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 51, 32, 32, 32, 32, 32, 32, 80, 111, 114, 116, 32, 66, 32, 68, 68, 82, 10, 73, 78, 84, 73, 77, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 56, 52, 9, 9, 84, 105, 109, 101, 114, 32, 111, 117, 116, 112, 117, 116, 10, 10, 84, 73, 77, 73, 78, 84, 32, 32, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 53, 10, 10, 9, 9, 59, 32, 85, 110, 117, 115, 101, 100, 47, 117, 110, 100, 101, 102, 105, 110, 101, 100, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 40, 36, 50, 56, 53, 45, 36, 50, 57, 52, 41, 10, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 54, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 55, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 56, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 57, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 65, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 66, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 67, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 68, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 69, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 56, 70, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 57, 48, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 57, 49, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 57, 50, 10, 9, 9, 9, 100, 115, 32, 49, 9, 59, 32, 36, 50, 57, 51, 10, 10, 84, 73, 77, 49, 84, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 57, 52, 9, 9, 115, 101, 116, 32, 49, 32, 99, 108, 111, 99, 107, 32, 105, 110, 116, 101, 114, 118, 97, 108, 10, 84, 73, 77, 56, 84, 32, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 57, 53, 32, 32, 32, 32, 32, 32, 115, 101, 116, 32, 56, 32, 99, 108, 111, 99, 107, 32, 105, 110, 116, 101, 114, 118, 97, 108, 10, 84, 73, 77, 54, 52, 84, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 57, 54, 32, 32, 32, 32, 32, 32, 115, 101, 116, 32, 54, 52, 32, 99, 108, 111, 99, 107, 32, 105, 110, 116, 101, 114, 118, 97, 108, 10, 84, 49, 48, 50, 52, 84, 32, 32, 32, 32, 32, 32, 100, 115, 32, 49, 32, 32, 32, 32, 59, 32, 36, 50, 57, 55, 32, 32, 32, 32, 32, 32, 115, 101, 116, 32, 49, 48, 50, 52, 32, 99, 108, 111, 99, 107, 32, 105, 110, 116, 101, 114, 118, 97, 108, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 84, 104, 101, 32, 102, 111, 108, 108, 111, 119, 105, 110, 103, 32, 114, 101, 113, 117, 105, 114, 101, 100, 32, 102, 111, 114, 32, 98, 97, 99, 107, 45, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 32, 119, 105, 116, 104, 32, 99, 111, 100, 101, 32, 119, 104, 105, 99, 104, 32, 100, 111, 101, 115, 32, 110, 111, 116, 32, 117, 115, 101, 10, 59, 32, 115, 101, 103, 109, 101, 110, 116, 115, 46, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 83, 69, 71, 10, 10, 59, 32, 69, 79, 70, 10 ]);
     Module["FS_createDataFile"]("/machines/atari2600", "vcs.h", fileData1, true, true, false);
     var fileData2 = [];
     fileData2.push.apply(fileData2, [ 59, 32, 77, 65, 67, 82, 79, 46, 72, 32, 102, 111, 114, 32, 67, 104, 97, 110, 110, 101, 108, 32, 70, 10, 59, 32, 86, 101, 114, 115, 105, 111, 110, 32, 49, 46, 48, 49, 44, 32, 50, 47, 78, 79, 86, 69, 77, 66, 69, 82, 47, 50, 48, 48, 52, 10, 10, 86, 69, 82, 83, 73, 79, 78, 95, 77, 65, 67, 82, 79, 9, 61, 32, 49, 48, 49, 10, 10, 59, 10, 59, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 32, 73, 83, 32, 69, 88, 80, 76, 73, 67, 73, 84, 76, 89, 32, 83, 85, 80, 80, 79, 82, 84, 69, 68, 32, 65, 83, 32, 65, 32, 68, 65, 83, 77, 45, 80, 82, 69, 70, 69, 82, 82, 69, 68, 32, 67, 79, 77, 80, 65, 78, 73, 79, 78, 32, 70, 73, 76, 69, 10, 59, 32, 80, 76, 69, 65, 83, 69, 32, 68, 79, 32, 42, 78, 79, 84, 42, 32, 82, 69, 68, 73, 83, 84, 82, 73, 66, 85, 84, 69, 32, 77, 79, 68, 73, 70, 73, 69, 68, 32, 86, 69, 82, 83, 73, 79, 78, 83, 32, 79, 70, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 33, 10, 59, 10, 59, 32, 84, 104, 105, 115, 32, 102, 105, 108, 101, 32, 100, 101, 102, 105, 110, 101, 115, 32, 68, 65, 83, 77, 32, 109, 97, 99, 114, 111, 115, 32, 117, 115, 101, 102, 117, 108, 32, 102, 111, 114, 32, 100, 101, 118, 101, 108, 111, 112, 109, 101, 110, 116, 32, 102, 111, 114, 32, 116, 104, 101, 32, 67, 104, 97, 110, 110, 101, 108, 32, 70, 46, 10, 59, 32, 73, 116, 32, 105, 115, 32, 100, 105, 115, 116, 114, 105, 98, 117, 116, 101, 100, 32, 97, 115, 32, 97, 32, 99, 111, 109, 112, 97, 110, 105, 111, 110, 32, 109, 97, 99, 104, 105, 110, 101, 45, 115, 112, 101, 99, 105, 102, 105, 99, 32, 115, 117, 112, 112, 111, 114, 116, 32, 112, 97, 99, 107, 97, 103, 101, 10, 59, 32, 102, 111, 114, 32, 116, 104, 101, 32, 68, 65, 83, 77, 32, 99, 111, 109, 112, 105, 108, 101, 114, 46, 32, 85, 112, 100, 97, 116, 101, 115, 32, 116, 111, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 68, 65, 83, 77, 44, 32, 97, 110, 100, 32, 97, 115, 115, 111, 99, 105, 97, 116, 101, 100, 32, 116, 111, 111, 108, 115, 32, 97, 114, 101, 10, 59, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 32, 97, 116, 32, 97, 116, 32, 104, 116, 116, 112, 58, 47, 47, 119, 119, 119, 46, 97, 116, 97, 114, 105, 50, 54, 48, 48, 46, 111, 114, 103, 47, 100, 97, 115, 109, 10, 59, 10, 59, 32, 77, 97, 110, 121, 32, 116, 104, 97, 110, 107, 115, 32, 116, 111, 32, 116, 104, 101, 32, 112, 101, 111, 112, 108, 101, 32, 119, 104, 111, 32, 104, 97, 118, 101, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 100, 46, 32, 32, 73, 102, 32, 121, 111, 117, 32, 116, 97, 107, 101, 32, 105, 115, 115, 117, 101, 32, 119, 105, 116, 104, 32, 116, 104, 101, 10, 59, 32, 99, 111, 110, 116, 101, 110, 116, 115, 44, 32, 111, 114, 32, 119, 111, 117, 108, 100, 32, 108, 105, 107, 101, 32, 116, 111, 32, 97, 100, 100, 32, 115, 111, 109, 101, 116, 104, 105, 110, 103, 44, 32, 112, 108, 101, 97, 115, 101, 32, 119, 114, 105, 116, 101, 32, 116, 111, 32, 109, 101, 10, 59, 32, 40, 97, 116, 97, 114, 105, 50, 54, 48, 48, 64, 116, 97, 115, 119, 101, 103, 105, 97, 110, 46, 99, 111, 109, 41, 32, 119, 105, 116, 104, 32, 121, 111, 117, 114, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 105, 111, 110, 46, 10, 59, 10, 59, 32, 76, 97, 116, 101, 115, 116, 32, 82, 101, 118, 105, 115, 105, 111, 110, 115, 46, 46, 46, 10, 59, 10, 59, 32, 49, 46, 48, 49, 32, 32, 32, 50, 47, 78, 79, 86, 47, 50, 48, 48, 52, 32, 32, 32, 32, 32, 67, 111, 110, 116, 114, 105, 98, 117, 116, 105, 111, 110, 32, 102, 114, 111, 109, 32, 75, 101, 118, 105, 110, 32, 76, 105, 112, 101, 10, 59, 32, 49, 46, 48, 48, 32, 32, 51, 49, 47, 79, 67, 84, 47, 50, 48, 48, 52, 32, 32, 32, 32, 32, 45, 32, 105, 110, 105, 116, 105, 97, 108, 32, 118, 101, 114, 115, 105, 111, 110, 10, 10, 10, 10, 59, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 10, 59, 32, 77, 32, 65, 32, 67, 32, 82, 32, 79, 32, 83, 10, 59, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 67, 65, 82, 84, 82, 73, 68, 71, 69, 95, 83, 84, 65, 82, 84, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 65, 117, 116, 104, 111, 114, 58, 32, 83, 101, 97, 110, 32, 82, 105, 100, 100, 108, 101, 10, 59, 32, 73, 110, 115, 101, 114, 116, 115, 32, 116, 104, 101, 32, 36, 53, 53, 32, 116, 104, 97, 116, 32, 115, 105, 103, 110, 97, 108, 115, 32, 97, 32, 118, 97, 108, 105, 100, 32, 67, 104, 97, 110, 110, 101, 108, 32, 70, 32, 99, 97, 114, 116, 114, 105, 100, 103, 101, 32, 97, 110, 100, 10, 59, 32, 116, 104, 101, 110, 32, 105, 110, 115, 101, 114, 116, 115, 32, 116, 104, 101, 32, 78, 79, 80, 32, 116, 104, 97, 116, 32, 116, 97, 107, 101, 115, 32, 117, 112, 32, 116, 104, 101, 32, 110, 101, 120, 116, 32, 98, 121, 116, 101, 44, 32, 119, 104, 105, 99, 104, 32, 112, 108, 97, 99, 101, 115, 10, 59, 32, 116, 104, 101, 32, 67, 104, 97, 110, 110, 101, 108, 32, 70, 32, 97, 116, 32, 116, 104, 101, 32, 99, 97, 114, 116, 114, 105, 100, 103, 101, 32, 101, 110, 116, 114, 121, 32, 112, 111, 105, 110, 116, 44, 32, 36, 56, 48, 50, 46, 10, 10, 77, 65, 67, 32, 67, 65, 82, 84, 82, 73, 68, 71, 69, 95, 83, 84, 65, 82, 84, 10, 67, 97, 114, 116, 114, 105, 100, 103, 101, 83, 116, 97, 114, 116, 58, 32, 100, 98, 32, 36, 53, 53, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 118, 97, 108, 105, 100, 32, 99, 97, 114, 116, 32, 105, 110, 100, 105, 99, 97, 116, 111, 114, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 78, 79, 80, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 117, 110, 117, 115, 101, 100, 32, 98, 121, 116, 101, 10, 69, 78, 68, 77, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 80, 82, 79, 77, 80, 84, 83, 95, 78, 79, 95, 84, 10, 59, 32, 79, 114, 105, 103, 105, 110, 97, 108, 32, 65, 117, 116, 104, 111, 114, 58, 32, 83, 101, 97, 110, 32, 82, 105, 100, 100, 108, 101, 10, 59, 32, 84, 104, 105, 115, 32, 99, 111, 100, 101, 32, 102, 117, 110, 99, 116, 105, 111, 110, 115, 32, 116, 104, 101, 32, 115, 97, 109, 101, 32, 97, 115, 32, 116, 104, 101, 32, 34, 112, 114, 111, 109, 112, 116, 115, 34, 32, 115, 101, 99, 116, 105, 111, 110, 32, 111, 102, 32, 116, 104, 101, 32, 66, 73, 79, 83, 44, 10, 59, 32, 98, 117, 116, 32, 116, 104, 105, 115, 32, 99, 111, 100, 101, 32, 100, 111, 101, 115, 110, 39, 116, 32, 104, 97, 118, 101, 32, 97, 32, 34, 84, 63, 34, 32, 112, 114, 111, 109, 112, 116, 44, 32, 115, 111, 32, 105, 116, 39, 115, 32, 117, 115, 101, 102, 117, 108, 32, 105, 110, 32, 103, 97, 109, 101, 115, 32, 116, 104, 97, 116, 10, 59, 32, 100, 111, 110, 39, 116, 32, 104, 97, 118, 101, 32, 116, 105, 109, 101, 32, 108, 105, 109, 105, 116, 115, 32, 111, 114, 32, 115, 101, 116, 116, 105, 110, 103, 115, 46, 10, 10, 77, 65, 67, 32, 80, 82, 79, 77, 80, 84, 83, 95, 78, 79, 84, 10, 112, 114, 111, 109, 112, 116, 115, 32, 83, 85, 66, 82, 79, 85, 84, 73, 78, 69, 10, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 75, 44, 80, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 73, 32, 32, 32, 112, 117, 115, 104, 107, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 46, 112, 114, 111, 109, 112, 116, 115, 50, 58, 32, 32, 32, 32, 32, 32, 76, 73, 32, 32, 32, 36, 56, 53, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 114, 101, 100, 32, 53, 32, 40, 83, 41, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 36, 48, 44, 65, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 73, 32, 32, 32, 112, 114, 111, 109, 112, 116, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 65, 44, 36, 52, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 67, 73, 32, 32, 32, 36, 48, 56, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 105, 115, 32, 105, 116, 32, 98, 117, 116, 116, 111, 110, 32, 52, 44, 32, 83, 116, 97, 114, 116, 63, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 66, 70, 32, 32, 32, 36, 52, 44, 46, 110, 111, 116, 98, 117, 116, 52, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 110, 111, 44, 32, 99, 104, 101, 99, 107, 32, 111, 116, 104, 101, 114, 115, 10, 46, 110, 111, 116, 98, 117, 116, 50, 58, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 73, 32, 32, 32, 112, 111, 112, 107, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 121, 101, 115, 44, 32, 114, 101, 116, 117, 114, 110, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 75, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 10, 46, 110, 111, 116, 98, 117, 116, 52, 58, 32, 32, 32, 32, 32, 32, 32, 67, 73, 32, 32, 32, 36, 48, 50, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 105, 115, 32, 105, 116, 32, 98, 117, 116, 116, 111, 110, 32, 50, 44, 32, 77, 111, 100, 101, 63, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 66, 70, 32, 32, 32, 36, 52, 44, 46, 110, 111, 116, 98, 117, 116, 50, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 73, 32, 32, 32, 36, 56, 101, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 114, 101, 100, 32, 77, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 36, 48, 44, 65, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 73, 32, 32, 32, 112, 114, 111, 109, 112, 116, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 73, 83, 85, 32, 51, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 73, 83, 76, 32, 54, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 65, 44, 40, 73, 83, 41, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 97, 115, 32, 52, 32, 59, 97, 100, 100, 32, 116, 104, 101, 32, 109, 111, 100, 101, 32, 116, 111, 32, 116, 104, 101, 32, 103, 97, 109, 101, 32, 35, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 76, 82, 32, 32, 32, 40, 73, 83, 41, 44, 65, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 66, 70, 32, 32, 32, 36, 48, 44, 46, 112, 114, 111, 109, 112, 116, 115, 50, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 10, 69, 78, 68, 77, 10, 10, 10, 10, 59, 32, 69, 79, 70, 10 ]);
     Module["FS_createDataFile"]("/machines/channel-f", "macro.h", fileData2, true, true, false);
     var fileData3 = [];
     fileData3.push.apply(fileData3, [ 59, 32, 86, 69, 83, 46, 72, 10, 59, 32, 70, 97, 105, 114, 99, 104, 105, 108, 100, 32, 67, 104, 97, 110, 110, 101, 108, 32, 70, 32, 72, 101, 97, 100, 101, 114, 10, 59, 32, 86, 101, 114, 115, 105, 111, 110, 32, 49, 46, 48, 49, 44, 32, 50, 47, 78, 79, 86, 69, 77, 66, 69, 82, 47, 50, 48, 48, 52, 10, 10, 86, 69, 82, 83, 73, 79, 78, 95, 67, 72, 65, 78, 78, 69, 76, 70, 9, 61, 32, 49, 48, 49, 10, 86, 69, 82, 83, 73, 79, 78, 95, 86, 69, 83, 9, 9, 61, 32, 49, 48, 49, 10, 10, 59, 32, 84, 72, 73, 83, 32, 73, 83, 32, 65, 32, 80, 82, 69, 76, 73, 77, 73, 78, 65, 82, 89, 32, 82, 69, 76, 69, 65, 83, 69, 32, 79, 70, 32, 42, 84, 72, 69, 42, 32, 34, 83, 84, 65, 78, 68, 65, 82, 68, 34, 32, 86, 69, 83, 46, 72, 10, 59, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 32, 73, 83, 32, 69, 88, 80, 76, 73, 67, 73, 84, 76, 89, 32, 83, 85, 80, 80, 79, 82, 84, 69, 68, 32, 65, 83, 32, 65, 32, 68, 65, 83, 77, 45, 80, 82, 69, 70, 69, 82, 82, 69, 68, 32, 67, 79, 77, 80, 65, 78, 73, 79, 78, 32, 70, 73, 76, 69, 10, 59, 32, 80, 76, 69, 65, 83, 69, 32, 68, 79, 32, 42, 78, 79, 84, 42, 32, 82, 69, 68, 73, 83, 84, 82, 73, 66, 85, 84, 69, 32, 84, 72, 73, 83, 32, 70, 73, 76, 69, 33, 10, 59, 10, 59, 32, 84, 104, 105, 115, 32, 102, 105, 108, 101, 32, 100, 101, 102, 105, 110, 101, 115, 32, 104, 97, 114, 100, 119, 97, 114, 101, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 32, 97, 110, 100, 32, 109, 101, 109, 111, 114, 121, 32, 109, 97, 112, 112, 105, 110, 103, 32, 102, 111, 114, 32, 116, 104, 101, 10, 59, 32, 70, 97, 105, 114, 99, 104, 105, 108, 100, 32, 67, 104, 97, 110, 110, 101, 108, 45, 70, 46, 32, 73, 116, 32, 105, 115, 32, 100, 105, 115, 116, 114, 105, 98, 117, 116, 101, 100, 32, 97, 115, 32, 97, 32, 99, 111, 109, 112, 97, 110, 105, 111, 110, 32, 109, 97, 99, 104, 105, 110, 101, 45, 115, 112, 101, 99, 105, 102, 105, 99, 32, 115, 117, 112, 112, 111, 114, 116, 32, 112, 97, 99, 107, 97, 103, 101, 10, 59, 32, 102, 111, 114, 32, 116, 104, 101, 32, 68, 65, 83, 77, 32, 99, 111, 109, 112, 105, 108, 101, 114, 46, 32, 85, 112, 100, 97, 116, 101, 115, 32, 116, 111, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 68, 65, 83, 77, 44, 32, 97, 110, 100, 32, 97, 115, 115, 111, 99, 105, 97, 116, 101, 100, 32, 116, 111, 111, 108, 115, 32, 97, 114, 101, 10, 59, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 32, 97, 116, 32, 97, 116, 32, 104, 116, 116, 112, 58, 47, 47, 119, 119, 119, 46, 97, 116, 97, 114, 105, 50, 54, 48, 48, 46, 111, 114, 103, 47, 100, 97, 115, 109, 10, 59, 10, 59, 32, 77, 97, 110, 121, 32, 116, 104, 97, 110, 107, 115, 32, 116, 111, 32, 116, 104, 101, 32, 111, 114, 105, 103, 105, 110, 97, 108, 32, 97, 117, 116, 104, 111, 114, 40, 115, 41, 32, 111, 102, 32, 116, 104, 105, 115, 32, 102, 105, 108, 101, 44, 32, 97, 110, 100, 32, 116, 111, 32, 101, 118, 101, 114, 121, 111, 110, 101, 32, 119, 104, 111, 32, 104, 97, 115, 10, 59, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 100, 32, 116, 111, 32, 117, 110, 100, 101, 114, 115, 116, 97, 110, 100, 105, 110, 103, 32, 116, 104, 101, 32, 67, 104, 97, 110, 110, 101, 108, 45, 70, 46, 32, 32, 73, 102, 32, 121, 111, 117, 32, 116, 97, 107, 101, 32, 105, 115, 115, 117, 101, 32, 119, 105, 116, 104, 32, 116, 104, 101, 10, 59, 32, 99, 111, 110, 116, 101, 110, 116, 115, 44, 32, 111, 114, 32, 110, 97, 109, 105, 110, 103, 32, 111, 102, 32, 114, 101, 103, 105, 115, 116, 101, 114, 115, 44, 32, 112, 108, 101, 97, 115, 101, 32, 119, 114, 105, 116, 101, 32, 116, 111, 32, 109, 101, 32, 40, 97, 116, 97, 114, 105, 50, 54, 48, 48, 64, 116, 97, 115, 119, 101, 103, 105, 97, 110, 46, 99, 111, 109, 41, 10, 59, 32, 119, 105, 116, 104, 32, 121, 111, 117, 114, 32, 118, 105, 101, 119, 115, 46, 32, 32, 80, 108, 101, 97, 115, 101, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 44, 32, 105, 102, 32, 121, 111, 117, 32, 116, 104, 105, 110, 107, 32, 121, 111, 117, 32, 99, 97, 110, 32, 105, 109, 112, 114, 111, 118, 101, 32, 116, 104, 105, 115, 10, 59, 32, 102, 105, 108, 101, 33, 10, 59, 10, 59, 32, 76, 97, 116, 101, 115, 116, 32, 82, 101, 118, 105, 115, 105, 111, 110, 115, 46, 46, 46, 10, 59, 32, 49, 46, 48, 49, 32, 32, 32, 50, 47, 78, 79, 86, 47, 50, 48, 48, 52, 9, 75, 101, 118, 105, 110, 32, 76, 105, 112, 101, 39, 115, 32, 118, 101, 114, 115, 105, 111, 110, 32, 40, 99, 111, 109, 98, 105, 110, 101, 100, 32, 109, 97, 99, 114, 111, 47, 104, 101, 97, 100, 101, 114, 41, 10, 59, 9, 9, 9, 114, 101, 110, 97, 109, 101, 100, 32, 116, 111, 32, 86, 69, 83, 46, 72, 10, 59, 9, 9, 9, 97, 108, 116, 101, 114, 110, 97, 116, 101, 115, 32, 112, 114, 111, 118, 105, 100, 101, 100, 32, 102, 111, 114, 32, 100, 101, 112, 114, 101, 99, 97, 116, 101, 100, 32, 101, 113, 117, 97, 116, 101, 115, 10, 59, 9, 9, 9, 65, 76, 76, 32, 104, 97, 114, 100, 119, 97, 114, 101, 47, 66, 73, 79, 83, 32, 101, 113, 117, 97, 116, 101, 115, 32, 110, 111, 119, 32, 105, 110, 32, 117, 112, 112, 101, 114, 99, 97, 115, 101, 32, 97, 110, 100, 32, 112, 114, 101, 102, 105, 120, 101, 100, 10, 59, 32, 49, 46, 48, 48, 32, 32, 51, 49, 47, 79, 67, 84, 47, 50, 48, 48, 52, 9, 45, 32, 105, 110, 105, 116, 105, 97, 108, 32, 114, 101, 108, 101, 97, 115, 101, 10, 10, 10, 10, 59, 32, 80, 108, 101, 97, 115, 101, 32, 99, 111, 110, 116, 114, 105, 98, 117, 116, 101, 32, 67, 104, 97, 110, 110, 101, 108, 45, 70, 32, 104, 101, 97, 100, 101, 114, 32, 99, 111, 100, 101, 32, 116, 111, 32, 97, 116, 97, 114, 105, 50, 54, 48, 48, 64, 116, 97, 115, 119, 101, 103, 105, 97, 110, 46, 99, 111, 109, 10, 10, 10, 10, 73, 78, 67, 76, 85, 68, 69, 95, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 114, 101, 109, 111, 118, 101, 32, 116, 111, 32, 68, 73, 83, 65, 66, 76, 69, 32, 100, 101, 112, 114, 101, 99, 97, 116, 101, 100, 32, 101, 113, 117, 97, 116, 101, 115, 10, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 66, 73, 79, 83, 32, 67, 97, 108, 108, 115, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 66, 73, 79, 83, 95, 67, 76, 69, 65, 82, 95, 83, 67, 82, 69, 69, 78, 32, 32, 32, 61, 32, 36, 48, 48, 100, 48, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 117, 115, 101, 115, 32, 114, 51, 49, 10, 66, 73, 79, 83, 95, 68, 69, 76, 65, 89, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 48, 48, 56, 102, 10, 66, 73, 79, 83, 95, 80, 85, 83, 72, 95, 75, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 48, 49, 48, 55, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 117, 115, 101, 100, 32, 116, 111, 32, 97, 108, 108, 111, 119, 32, 109, 111, 114, 101, 32, 115, 117, 98, 114, 111, 117, 116, 105, 110, 101, 32, 115, 116, 97, 99, 107, 32, 115, 112, 97, 99, 101, 10, 66, 73, 79, 83, 95, 80, 79, 80, 95, 75, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 48, 49, 49, 101, 10, 66, 73, 79, 83, 95, 68, 82, 65, 87, 95, 67, 72, 65, 82, 65, 67, 84, 69, 82, 32, 61, 32, 36, 48, 54, 55, 57, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 67, 111, 108, 111, 114, 115, 10, 10, 67, 79, 76, 79, 82, 95, 82, 69, 68, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 52, 48, 10, 67, 79, 76, 79, 82, 95, 66, 76, 85, 69, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 56, 48, 10, 67, 79, 76, 79, 82, 95, 71, 82, 69, 69, 78, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 36, 48, 48, 10, 67, 79, 76, 79, 82, 95, 66, 65, 67, 75, 71, 82, 79, 85, 78, 68, 32, 32, 32, 32, 61, 32, 36, 67, 48, 10, 10, 59, 32, 65, 108, 116, 101, 114, 110, 97, 116, 101, 32, 40, 69, 117, 114, 111, 112, 101, 97, 110, 41, 32, 115, 112, 101, 108, 108, 105, 110, 103, 115, 46, 46, 46, 10, 10, 67, 79, 76, 79, 85, 82, 95, 82, 69, 83, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 82, 69, 68, 10, 67, 79, 76, 79, 85, 82, 95, 66, 76, 85, 69, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 66, 76, 85, 69, 10, 67, 79, 76, 79, 85, 82, 95, 71, 82, 69, 69, 78, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 71, 82, 69, 69, 78, 10, 67, 79, 76, 79, 85, 82, 95, 66, 65, 67, 75, 71, 82, 79, 85, 78, 68, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 66, 65, 67, 75, 71, 82, 79, 85, 78, 68, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 32, 101, 113, 117, 97, 116, 101, 115, 46, 10, 59, 32, 84, 104, 101, 115, 101, 32, 112, 114, 101, 115, 101, 110, 116, 32, 116, 111, 32, 98, 101, 32, 99, 111, 109, 112, 97, 116, 105, 98, 108, 101, 32, 119, 105, 116, 104, 32, 101, 120, 105, 115, 116, 105, 110, 103, 32, 101, 113, 117, 97, 116, 101, 32, 117, 115, 97, 103, 101, 46, 32, 32, 10, 59, 32, 68, 79, 32, 78, 79, 84, 32, 85, 83, 69, 32, 84, 72, 69, 83, 69, 32, 73, 78, 32, 78, 69, 87, 32, 67, 79, 68, 69, 32, 45, 45, 32, 87, 69, 32, 87, 65, 78, 84, 32, 84, 79, 32, 71, 69, 84, 32, 82, 73, 68, 32, 79, 70, 32, 84, 72, 69, 77, 33, 10, 10, 9, 73, 70, 67, 79, 78, 83, 84, 32, 73, 78, 67, 76, 85, 68, 69, 95, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 10, 10, 99, 108, 114, 115, 99, 114, 110, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 66, 73, 79, 83, 95, 67, 76, 69, 65, 82, 95, 83, 67, 82, 69, 69, 78, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 100, 101, 108, 97, 121, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 66, 73, 79, 83, 95, 68, 69, 76, 65, 89, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 112, 117, 115, 104, 107, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 66, 73, 79, 83, 95, 80, 85, 83, 72, 95, 75, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 112, 111, 112, 107, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 66, 73, 79, 83, 95, 80, 79, 80, 95, 75, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 100, 114, 97, 119, 99, 104, 97, 114, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 66, 73, 79, 83, 95, 68, 82, 65, 87, 95, 67, 72, 65, 82, 65, 67, 84, 69, 82, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 10, 114, 101, 100, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 82, 69, 68, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 33, 10, 98, 108, 117, 101, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 66, 76, 85, 69, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 10, 103, 114, 101, 101, 110, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 71, 82, 69, 69, 78, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 10, 98, 107, 103, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 61, 32, 67, 79, 76, 79, 82, 95, 66, 65, 67, 75, 71, 82, 79, 85, 78, 68, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 59, 32, 68, 69, 80, 82, 69, 67, 65, 84, 69, 68, 10, 10, 9, 69, 78, 68, 73, 70, 10, 10, 59, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 59, 32, 84, 104, 101, 32, 102, 111, 108, 108, 111, 119, 105, 110, 103, 32, 114, 101, 113, 117, 105, 114, 101, 100, 32, 102, 111, 114, 32, 98, 97, 99, 107, 45, 99, 111, 109, 112, 97, 116, 105, 98, 105, 108, 105, 116, 121, 32, 119, 105, 116, 104, 32, 99, 111, 100, 101, 32, 119, 104, 105, 99, 104, 32, 100, 111, 101, 115, 32, 110, 111, 116, 32, 117, 115, 101, 10, 59, 32, 115, 101, 103, 109, 101, 110, 116, 115, 46, 10, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 83, 69, 71, 10, 10, 59, 32, 69, 79, 70, 10 ]);
     Module["FS_createDataFile"]("/machines/channel-f", "ves.h", fileData3, true, true, false);
    }
    if (Module["calledRun"]) {
     runWithFS();
    } else {
     if (!Module["preRun"]) Module["preRun"] = [];
     Module["preRun"].push(runWithFS);
    }
   });
   loadPackage();
  }))();
  var Module;
  if (!Module) Module = (typeof DASM !== "undefined" ? DASM : null) || {};
  var moduleOverrides = {};
  for (var key in Module) {
   if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key];
   }
  }
  var ENVIRONMENT_IS_WEB = false;
  var ENVIRONMENT_IS_WORKER = false;
  var ENVIRONMENT_IS_NODE = false;
  var ENVIRONMENT_IS_SHELL = false;
  if (Module["ENVIRONMENT"]) {
   if (Module["ENVIRONMENT"] === "WEB") {
    ENVIRONMENT_IS_WEB = true;
   } else if (Module["ENVIRONMENT"] === "WORKER") {
    ENVIRONMENT_IS_WORKER = true;
   } else if (Module["ENVIRONMENT"] === "NODE") {
    ENVIRONMENT_IS_NODE = true;
   } else if (Module["ENVIRONMENT"] === "SHELL") {
    ENVIRONMENT_IS_SHELL = true;
   } else {
    throw new Error("The provided Module['ENVIRONMENT'] value is not valid. It must be one of: WEB|WORKER|NODE|SHELL.");
   }
  } else {
   ENVIRONMENT_IS_WEB = typeof window === "object";
   ENVIRONMENT_IS_WORKER = typeof importScripts === "function";
   ENVIRONMENT_IS_NODE = typeof process === "object" && typeof commonjsRequire === "function" && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
   ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
  }
  if (ENVIRONMENT_IS_NODE) {
   if (!Module["print"]) Module["print"] = console.log;
   if (!Module["printErr"]) Module["printErr"] = console.warn;
   var nodeFS;
   var nodePath;
   Module["read"] = function read(filename, binary) {
    if (!nodeFS) nodeFS = fs;
    if (!nodePath) nodePath = path$1;
    filename = nodePath["normalize"](filename);
    var ret = nodeFS["readFileSync"](filename);
    return binary ? ret : ret.toString();
   };
   Module["readBinary"] = function readBinary(filename) {
    var ret = Module["read"](filename, true);
    if (!ret.buffer) {
     ret = new Uint8Array(ret);
    }
    assert(ret.buffer);
    return ret;
   };
   Module["load"] = function load(f) {
    globalEval(read(f));
   };
   if (!Module["thisProgram"]) {
    if (process["argv"].length > 1) {
     Module["thisProgram"] = process["argv"][1].replace(/\\/g, "/");
    } else {
     Module["thisProgram"] = "unknown-program";
    }
   }
   Module["arguments"] = process["argv"].slice(2);
   {
    module["exports"] = Module;
   }
   process["on"]("uncaughtException", (function(ex) {
    if (!(ex instanceof ExitStatus)) {
     throw ex;
    }
   }));
   Module["inspect"] = (function() {
    return "[Emscripten Module object]";
   });
  } else if (ENVIRONMENT_IS_SHELL) {
   if (!Module["print"]) Module["print"] = print;
   if (typeof printErr != "undefined") Module["printErr"] = printErr;
   if (typeof read != "undefined") {
    Module["read"] = read;
   } else {
    Module["read"] = function read() {
     throw "no read() available";
    };
   }
   Module["readBinary"] = function readBinary(f) {
    if (typeof readbuffer === "function") {
     return new Uint8Array(readbuffer(f));
    }
    var data = read(f, "binary");
    assert(typeof data === "object");
    return data;
   };
   if (typeof scriptArgs != "undefined") {
    Module["arguments"] = scriptArgs;
   } else if (typeof arguments != "undefined") {
    Module["arguments"] = arguments;
   }
  } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
   Module["read"] = function read(url) {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, false);
    xhr.send(null);
    return xhr.responseText;
   };
   Module["readAsync"] = function readAsync(url, onload, onerror) {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function xhr_onload() {
     if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
      onload(xhr.response);
     } else {
      onerror();
     }
    };
    xhr.onerror = onerror;
    xhr.send(null);
   };
   if (typeof arguments != "undefined") {
    Module["arguments"] = arguments;
   }
   if (typeof console !== "undefined") {
    if (!Module["print"]) Module["print"] = function print(x) {
     console.log(x);
    };
    if (!Module["printErr"]) Module["printErr"] = function printErr(x) {
     console.warn(x);
    };
   } else {
    var TRY_USE_DUMP = false;
    if (!Module["print"]) Module["print"] = TRY_USE_DUMP && typeof dump !== "undefined" ? (function(x) {
     dump(x);
    }) : (function(x) {});
   }
   if (ENVIRONMENT_IS_WORKER) {
    Module["load"] = importScripts;
   }
   if (typeof Module["setWindowTitle"] === "undefined") {
    Module["setWindowTitle"] = (function(title) {
     document.title = title;
    });
   }
  } else {
   throw "Unknown runtime environment. Where are we?";
  }
  function globalEval(x) {
   eval.call(null, x);
  }
  if (!Module["load"] && Module["read"]) {
   Module["load"] = function load(f) {
    globalEval(Module["read"](f));
   };
  }
  if (!Module["print"]) {
   Module["print"] = (function() {});
  }
  if (!Module["printErr"]) {
   Module["printErr"] = Module["print"];
  }
  if (!Module["arguments"]) {
   Module["arguments"] = [];
  }
  if (!Module["thisProgram"]) {
   Module["thisProgram"] = "./this.program";
  }
  Module.print = Module["print"];
  Module.printErr = Module["printErr"];
  Module["preRun"] = [];
  Module["postRun"] = [];
  for (var key in moduleOverrides) {
   if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key];
   }
  }
  moduleOverrides = undefined;
  var Runtime = {
   setTempRet0: (function(value) {
    tempRet0 = value;
   }),
   getTempRet0: (function() {
    return tempRet0;
   }),
   stackSave: (function() {
    return STACKTOP;
   }),
   stackRestore: (function(stackTop) {
    STACKTOP = stackTop;
   }),
   getNativeTypeSize: (function(type) {
    switch (type) {
    case "i1":
    case "i8":
     return 1;
    case "i16":
     return 2;
    case "i32":
     return 4;
    case "i64":
     return 8;
    case "float":
     return 4;
    case "double":
     return 8;
    default:
     {
      if (type[type.length - 1] === "*") {
       return Runtime.QUANTUM_SIZE;
      } else if (type[0] === "i") {
       var bits = parseInt(type.substr(1));
       assert(bits % 8 === 0);
       return bits / 8;
      } else {
       return 0;
      }
     }
    }
   }),
   getNativeFieldSize: (function(type) {
    return Math.max(Runtime.getNativeTypeSize(type), Runtime.QUANTUM_SIZE);
   }),
   STACK_ALIGN: 16,
   prepVararg: (function(ptr, type) {
    if (type === "double" || type === "i64") {
     if (ptr & 7) {
      assert((ptr & 7) === 4);
      ptr += 4;
     }
    } else {
     assert((ptr & 3) === 0);
    }
    return ptr;
   }),
   getAlignSize: (function(type, size, vararg) {
    if (!vararg && (type == "i64" || type == "double")) return 8;
    if (!type) return Math.min(size, 8);
    return Math.min(size || (type ? Runtime.getNativeFieldSize(type) : 0), Runtime.QUANTUM_SIZE);
   }),
   dynCall: (function(sig, ptr, args) {
    if (args && args.length) {
     return Module["dynCall_" + sig].apply(null, [ ptr ].concat(args));
    } else {
     return Module["dynCall_" + sig].call(null, ptr);
    }
   }),
   functionPointers: [],
   addFunction: (function(func) {
    for (var i = 0; i < Runtime.functionPointers.length; i++) {
     if (!Runtime.functionPointers[i]) {
      Runtime.functionPointers[i] = func;
      return 2 * (1 + i);
     }
    }
    throw "Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.";
   }),
   removeFunction: (function(index) {
    Runtime.functionPointers[(index - 2) / 2] = null;
   }),
   warnOnce: (function(text) {
    if (!Runtime.warnOnce.shown) Runtime.warnOnce.shown = {};
    if (!Runtime.warnOnce.shown[text]) {
     Runtime.warnOnce.shown[text] = 1;
     Module.printErr(text);
    }
   }),
   funcWrappers: {},
   getFuncWrapper: (function(func, sig) {
    assert(sig);
    if (!Runtime.funcWrappers[sig]) {
     Runtime.funcWrappers[sig] = {};
    }
    var sigCache = Runtime.funcWrappers[sig];
    if (!sigCache[func]) {
     if (sig.length === 1) {
      sigCache[func] = function dynCall_wrapper() {
       return Runtime.dynCall(sig, func);
      };
     } else if (sig.length === 2) {
      sigCache[func] = function dynCall_wrapper(arg) {
       return Runtime.dynCall(sig, func, [ arg ]);
      };
     } else {
      sigCache[func] = function dynCall_wrapper() {
       return Runtime.dynCall(sig, func, Array.prototype.slice.call(arguments));
      };
     }
    }
    return sigCache[func];
   }),
   getCompilerSetting: (function(name) {
    throw "You must build with -s RETAIN_COMPILER_SETTINGS=1 for Runtime.getCompilerSetting or emscripten_get_compiler_setting to work";
   }),
   stackAlloc: (function(size) {
    var ret = STACKTOP;
    STACKTOP = STACKTOP + size | 0;
    STACKTOP = STACKTOP + 15 & -16;
    return ret;
   }),
   staticAlloc: (function(size) {
    var ret = STATICTOP;
    STATICTOP = STATICTOP + size | 0;
    STATICTOP = STATICTOP + 15 & -16;
    return ret;
   }),
   dynamicAlloc: (function(size) {
    var ret = HEAP32[DYNAMICTOP_PTR >> 2];
    var end = (ret + size + 15 | 0) & -16;
    HEAP32[DYNAMICTOP_PTR >> 2] = end;
    if (end >= TOTAL_MEMORY) {
     var success = enlargeMemory();
     if (!success) {
      HEAP32[DYNAMICTOP_PTR >> 2] = ret;
      return 0;
     }
    }
    return ret;
   }),
   alignMemory: (function(size, quantum) {
    var ret = size = Math.ceil(size / (quantum ? quantum : 16)) * (quantum ? quantum : 16);
    return ret;
   }),
   makeBigInt: (function(low, high, unsigned) {
    var ret = unsigned ? +(low >>> 0) + +(high >>> 0) * +4294967296 : +(low >>> 0) + +(high | 0) * +4294967296;
    return ret;
   }),
   GLOBAL_BASE: 8,
   QUANTUM_SIZE: 4,
   __dummy__: 0
  };
  Module["Runtime"] = Runtime;
  var ABORT = 0;
  var EXITSTATUS = 0;
  function assert(condition, text) {
   if (!condition) {
    abort("Assertion failed: " + text);
   }
  }
  function getCFunc(ident) {
   var func = Module["_" + ident];
   if (!func) {
    try {
     func = eval("_" + ident);
    } catch (e) {}
   }
   assert(func, "Cannot call unknown function " + ident + " (perhaps LLVM optimizations or closure removed it?)");
   return func;
  }
  var cwrap, ccall;
  ((function() {
   var JSfuncs = {
    "stackSave": (function() {
     Runtime.stackSave();
    }),
    "stackRestore": (function() {
     Runtime.stackRestore();
    }),
    "arrayToC": (function(arr) {
     var ret = Runtime.stackAlloc(arr.length);
     writeArrayToMemory(arr, ret);
     return ret;
    }),
    "stringToC": (function(str) {
     var ret = 0;
     if (str !== null && str !== undefined && str !== 0) {
      var len = (str.length << 2) + 1;
      ret = Runtime.stackAlloc(len);
      stringToUTF8(str, ret, len);
     }
     return ret;
    })
   };
   var toC = {
    "string": JSfuncs["stringToC"],
    "array": JSfuncs["arrayToC"]
   };
   ccall = function ccallFunc(ident, returnType, argTypes, args, opts) {
    var func = getCFunc(ident);
    var cArgs = [];
    var stack = 0;
    if (args) {
     for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
       if (stack === 0) stack = Runtime.stackSave();
       cArgs[i] = converter(args[i]);
      } else {
       cArgs[i] = args[i];
      }
     }
    }
    var ret = func.apply(null, cArgs);
    if (returnType === "string") ret = Pointer_stringify(ret);
    if (stack !== 0) {
     if (opts && opts.async) {
      EmterpreterAsync.asyncFinalizers.push((function() {
       Runtime.stackRestore(stack);
      }));
      return;
     }
     Runtime.stackRestore(stack);
    }
    return ret;
   };
   var sourceRegex = /^function\s*[a-zA-Z$_0-9]*\s*\(([^)]*)\)\s*{\s*([^*]*?)[\s;]*(?:return\s*(.*?)[;\s]*)?}$/;
   function parseJSFunc(jsfunc) {
    var parsed = jsfunc.toString().match(sourceRegex).slice(1);
    return {
     arguments: parsed[0],
     body: parsed[1],
     returnValue: parsed[2]
    };
   }
   var JSsource = null;
   function ensureJSsource() {
    if (!JSsource) {
     JSsource = {};
     for (var fun in JSfuncs) {
      if (JSfuncs.hasOwnProperty(fun)) {
       JSsource[fun] = parseJSFunc(JSfuncs[fun]);
      }
     }
    }
   }
   cwrap = function cwrap(ident, returnType, argTypes) {
    argTypes = argTypes || [];
    var cfunc = getCFunc(ident);
    var numericArgs = argTypes.every((function(type) {
     return type === "number";
    }));
    var numericRet = returnType !== "string";
    if (numericRet && numericArgs) {
     return cfunc;
    }
    var argNames = argTypes.map((function(x, i) {
     return "$" + i;
    }));
    var funcstr = "(function(" + argNames.join(",") + ") {";
    var nargs = argTypes.length;
    if (!numericArgs) {
     ensureJSsource();
     funcstr += "var stack = " + JSsource["stackSave"].body + ";";
     for (var i = 0; i < nargs; i++) {
      var arg = argNames[i], type = argTypes[i];
      if (type === "number") continue;
      var convertCode = JSsource[type + "ToC"];
      funcstr += "var " + convertCode.arguments + " = " + arg + ";";
      funcstr += convertCode.body + ";";
      funcstr += arg + "=(" + convertCode.returnValue + ");";
     }
    }
    var cfuncname = parseJSFunc((function() {
     return cfunc;
    })).returnValue;
    funcstr += "var ret = " + cfuncname + "(" + argNames.join(",") + ");";
    if (!numericRet) {
     var strgfy = parseJSFunc((function() {
      return Pointer_stringify;
     })).returnValue;
     funcstr += "ret = " + strgfy + "(ret);";
    }
    if (!numericArgs) {
     ensureJSsource();
     funcstr += JSsource["stackRestore"].body.replace("()", "(stack)") + ";";
    }
    funcstr += "return ret})";
    return eval(funcstr);
   };
  }))();
  Module["ccall"] = ccall;
  Module["cwrap"] = cwrap;
  function setValue(ptr, value, type, noSafe) {
   type = type || "i8";
   if (type.charAt(type.length - 1) === "*") type = "i32";
   switch (type) {
   case "i1":
    HEAP8[ptr >> 0] = value;
    break;
   case "i8":
    HEAP8[ptr >> 0] = value;
    break;
   case "i16":
    HEAP16[ptr >> 1] = value;
    break;
   case "i32":
    HEAP32[ptr >> 2] = value;
    break;
   case "i64":
    tempI64 = [ value >>> 0, (tempDouble = value, +Math_abs(tempDouble) >= +1 ? tempDouble > +0 ? (Math_min(+Math_floor(tempDouble / +4294967296), +4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / +4294967296) >>> 0 : 0) ], HEAP32[ptr >> 2] = tempI64[0], HEAP32[ptr + 4 >> 2] = tempI64[1];
    break;
   case "float":
    HEAPF32[ptr >> 2] = value;
    break;
   case "double":
    HEAPF64[ptr >> 3] = value;
    break;
   default:
    abort("invalid type for setValue: " + type);
   }
  }
  Module["setValue"] = setValue;
  function getValue(ptr, type, noSafe) {
   type = type || "i8";
   if (type.charAt(type.length - 1) === "*") type = "i32";
   switch (type) {
   case "i1":
    return HEAP8[ptr >> 0];
   case "i8":
    return HEAP8[ptr >> 0];
   case "i16":
    return HEAP16[ptr >> 1];
   case "i32":
    return HEAP32[ptr >> 2];
   case "i64":
    return HEAP32[ptr >> 2];
   case "float":
    return HEAPF32[ptr >> 2];
   case "double":
    return HEAPF64[ptr >> 3];
   default:
    abort("invalid type for setValue: " + type);
   }
   return null;
  }
  Module["getValue"] = getValue;
  var ALLOC_NORMAL = 0;
  var ALLOC_STACK = 1;
  var ALLOC_STATIC = 2;
  var ALLOC_DYNAMIC = 3;
  var ALLOC_NONE = 4;
  Module["ALLOC_NORMAL"] = ALLOC_NORMAL;
  Module["ALLOC_STACK"] = ALLOC_STACK;
  Module["ALLOC_STATIC"] = ALLOC_STATIC;
  Module["ALLOC_DYNAMIC"] = ALLOC_DYNAMIC;
  Module["ALLOC_NONE"] = ALLOC_NONE;
  function allocate(slab, types, allocator, ptr) {
   var zeroinit, size;
   if (typeof slab === "number") {
    zeroinit = true;
    size = slab;
   } else {
    zeroinit = false;
    size = slab.length;
   }
   var singleType = typeof types === "string" ? types : null;
   var ret;
   if (allocator == ALLOC_NONE) {
    ret = ptr;
   } else {
    ret = [ typeof _malloc === "function" ? _malloc : Runtime.staticAlloc, Runtime.stackAlloc, Runtime.staticAlloc, Runtime.dynamicAlloc ][allocator === undefined ? ALLOC_STATIC : allocator](Math.max(size, singleType ? 1 : types.length));
   }
   if (zeroinit) {
    var ptr = ret, stop;
    assert((ret & 3) == 0);
    stop = ret + (size & ~3);
    for (; ptr < stop; ptr += 4) {
     HEAP32[ptr >> 2] = 0;
    }
    stop = ret + size;
    while (ptr < stop) {
     HEAP8[ptr++ >> 0] = 0;
    }
    return ret;
   }
   if (singleType === "i8") {
    if (slab.subarray || slab.slice) {
     HEAPU8.set(slab, ret);
    } else {
     HEAPU8.set(new Uint8Array(slab), ret);
    }
    return ret;
   }
   var i = 0, type, typeSize, previousType;
   while (i < size) {
    var curr = slab[i];
    if (typeof curr === "function") {
     curr = Runtime.getFunctionIndex(curr);
    }
    type = singleType || types[i];
    if (type === 0) {
     i++;
     continue;
    }
    if (type == "i64") type = "i32";
    setValue(ret + i, curr, type);
    if (previousType !== type) {
     typeSize = Runtime.getNativeTypeSize(type);
     previousType = type;
    }
    i += typeSize;
   }
   return ret;
  }
  Module["allocate"] = allocate;
  function getMemory(size) {
   if (!staticSealed) return Runtime.staticAlloc(size);
   if (!runtimeInitialized) return Runtime.dynamicAlloc(size);
   return _malloc(size);
  }
  Module["getMemory"] = getMemory;
  function Pointer_stringify(ptr, length) {
   if (length === 0 || !ptr) return "";
   var hasUtf = 0;
   var t;
   var i = 0;
   while (1) {
    t = HEAPU8[ptr + i >> 0];
    hasUtf |= t;
    if (t == 0 && !length) break;
    i++;
    if (length && i == length) break;
   }
   if (!length) length = i;
   var ret = "";
   if (hasUtf < 128) {
    var MAX_CHUNK = 1024;
    var curr;
    while (length > 0) {
     curr = String.fromCharCode.apply(String, HEAPU8.subarray(ptr, ptr + Math.min(length, MAX_CHUNK)));
     ret = ret ? ret + curr : curr;
     ptr += MAX_CHUNK;
     length -= MAX_CHUNK;
    }
    return ret;
   }
   return Module["UTF8ToString"](ptr);
  }
  Module["Pointer_stringify"] = Pointer_stringify;
  function AsciiToString(ptr) {
   var str = "";
   while (1) {
    var ch = HEAP8[ptr++ >> 0];
    if (!ch) return str;
    str += String.fromCharCode(ch);
   }
  }
  Module["AsciiToString"] = AsciiToString;
  function stringToAscii(str, outPtr) {
   return writeAsciiToMemory(str, outPtr, false);
  }
  Module["stringToAscii"] = stringToAscii;
  var UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;
  function UTF8ArrayToString(u8Array, idx) {
   var endPtr = idx;
   while (u8Array[endPtr]) ++endPtr;
   if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(u8Array.subarray(idx, endPtr));
   } else {
    var u0, u1, u2, u3, u4, u5;
    var str = "";
    while (1) {
     u0 = u8Array[idx++];
     if (!u0) return str;
     if (!(u0 & 128)) {
      str += String.fromCharCode(u0);
      continue;
     }
     u1 = u8Array[idx++] & 63;
     if ((u0 & 224) == 192) {
      str += String.fromCharCode((u0 & 31) << 6 | u1);
      continue;
     }
     u2 = u8Array[idx++] & 63;
     if ((u0 & 240) == 224) {
      u0 = (u0 & 15) << 12 | u1 << 6 | u2;
     } else {
      u3 = u8Array[idx++] & 63;
      if ((u0 & 248) == 240) {
       u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | u3;
      } else {
       u4 = u8Array[idx++] & 63;
       if ((u0 & 252) == 248) {
        u0 = (u0 & 3) << 24 | u1 << 18 | u2 << 12 | u3 << 6 | u4;
       } else {
        u5 = u8Array[idx++] & 63;
        u0 = (u0 & 1) << 30 | u1 << 24 | u2 << 18 | u3 << 12 | u4 << 6 | u5;
       }
      }
     }
     if (u0 < 65536) {
      str += String.fromCharCode(u0);
     } else {
      var ch = u0 - 65536;
      str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
     }
    }
   }
  }
  Module["UTF8ArrayToString"] = UTF8ArrayToString;
  function UTF8ToString(ptr) {
   return UTF8ArrayToString(HEAPU8, ptr);
  }
  Module["UTF8ToString"] = UTF8ToString;
  function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
   if (!(maxBytesToWrite > 0)) return 0;
   var startIdx = outIdx;
   var endIdx = outIdx + maxBytesToWrite - 1;
   for (var i = 0; i < str.length; ++i) {
    var u = str.charCodeAt(i);
    if (u >= 55296 && u <= 57343) u = 65536 + ((u & 1023) << 10) | str.charCodeAt(++i) & 1023;
    if (u <= 127) {
     if (outIdx >= endIdx) break;
     outU8Array[outIdx++] = u;
    } else if (u <= 2047) {
     if (outIdx + 1 >= endIdx) break;
     outU8Array[outIdx++] = 192 | u >> 6;
     outU8Array[outIdx++] = 128 | u & 63;
    } else if (u <= 65535) {
     if (outIdx + 2 >= endIdx) break;
     outU8Array[outIdx++] = 224 | u >> 12;
     outU8Array[outIdx++] = 128 | u >> 6 & 63;
     outU8Array[outIdx++] = 128 | u & 63;
    } else if (u <= 2097151) {
     if (outIdx + 3 >= endIdx) break;
     outU8Array[outIdx++] = 240 | u >> 18;
     outU8Array[outIdx++] = 128 | u >> 12 & 63;
     outU8Array[outIdx++] = 128 | u >> 6 & 63;
     outU8Array[outIdx++] = 128 | u & 63;
    } else if (u <= 67108863) {
     if (outIdx + 4 >= endIdx) break;
     outU8Array[outIdx++] = 248 | u >> 24;
     outU8Array[outIdx++] = 128 | u >> 18 & 63;
     outU8Array[outIdx++] = 128 | u >> 12 & 63;
     outU8Array[outIdx++] = 128 | u >> 6 & 63;
     outU8Array[outIdx++] = 128 | u & 63;
    } else {
     if (outIdx + 5 >= endIdx) break;
     outU8Array[outIdx++] = 252 | u >> 30;
     outU8Array[outIdx++] = 128 | u >> 24 & 63;
     outU8Array[outIdx++] = 128 | u >> 18 & 63;
     outU8Array[outIdx++] = 128 | u >> 12 & 63;
     outU8Array[outIdx++] = 128 | u >> 6 & 63;
     outU8Array[outIdx++] = 128 | u & 63;
    }
   }
   outU8Array[outIdx] = 0;
   return outIdx - startIdx;
  }
  Module["stringToUTF8Array"] = stringToUTF8Array;
  function stringToUTF8(str, outPtr, maxBytesToWrite) {
   return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
  }
  Module["stringToUTF8"] = stringToUTF8;
  function lengthBytesUTF8(str) {
   var len = 0;
   for (var i = 0; i < str.length; ++i) {
    var u = str.charCodeAt(i);
    if (u >= 55296 && u <= 57343) u = 65536 + ((u & 1023) << 10) | str.charCodeAt(++i) & 1023;
    if (u <= 127) {
     ++len;
    } else if (u <= 2047) {
     len += 2;
    } else if (u <= 65535) {
     len += 3;
    } else if (u <= 2097151) {
     len += 4;
    } else if (u <= 67108863) {
     len += 5;
    } else {
     len += 6;
    }
   }
   return len;
  }
  Module["lengthBytesUTF8"] = lengthBytesUTF8;
  var UTF16Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;
  function demangle(func) {
   var hasLibcxxabi = !!Module["___cxa_demangle"];
   if (hasLibcxxabi) {
    try {
     var s = func.substr(1);
     var len = lengthBytesUTF8(s) + 1;
     var buf = _malloc(len);
     stringToUTF8(s, buf, len);
     var status = _malloc(4);
     var ret = Module["___cxa_demangle"](buf, 0, 0, status);
     if (getValue(status, "i32") === 0 && ret) {
      return Pointer_stringify(ret);
     }
    } catch (e) {} finally {
     if (buf) _free(buf);
     if (status) _free(status);
     if (ret) _free(ret);
    }
    return func;
   }
   Runtime.warnOnce("warning: build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling");
   return func;
  }
  function demangleAll(text) {
   return text.replace(/__Z[\w\d_]+/g, (function(x) {
    var y = demangle(x);
    return x === y ? x : x + " [" + y + "]";
   }));
  }
  function jsStackTrace() {
   var err = new Error;
   if (!err.stack) {
    try {
     throw new Error(0);
    } catch (e) {
     err = e;
    }
    if (!err.stack) {
     return "(no stack trace available)";
    }
   }
   return err.stack.toString();
  }
  function stackTrace() {
   var js = jsStackTrace();
   if (Module["extraStackTrace"]) js += "\n" + Module["extraStackTrace"]();
   return demangleAll(js);
  }
  Module["stackTrace"] = stackTrace;
  var HEAP;
  var buffer;
  var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
  function updateGlobalBufferViews() {
   Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
   Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
   Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
   Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
   Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
   Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
   Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
   Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer);
  }
  var STATIC_BASE, STATICTOP, staticSealed;
  var STACK_BASE, STACKTOP, STACK_MAX;
  var DYNAMIC_BASE, DYNAMICTOP_PTR;
  STATIC_BASE = STATICTOP = STACK_BASE = STACKTOP = STACK_MAX = DYNAMIC_BASE = DYNAMICTOP_PTR = 0;
  staticSealed = false;
  function abortOnCannotGrowMemory() {
   abort("Cannot enlarge memory arrays. Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value " + TOTAL_MEMORY + ", (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which adjusts the size at runtime but prevents some optimizations, (3) set Module.TOTAL_MEMORY to a higher value before the program runs, or if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ");
  }
  function enlargeMemory() {
   abortOnCannotGrowMemory();
  }
  var TOTAL_STACK = Module["TOTAL_STACK"] || 5242880;
  var TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 16777216;
  var WASM_PAGE_SIZE = 64 * 1024;
  var totalMemory = WASM_PAGE_SIZE;
  while (totalMemory < TOTAL_MEMORY || totalMemory < 2 * TOTAL_STACK) {
   if (totalMemory < 16 * 1024 * 1024) {
    totalMemory *= 2;
   } else {
    totalMemory += 16 * 1024 * 1024;
   }
  }
  if (totalMemory !== TOTAL_MEMORY) {
   TOTAL_MEMORY = totalMemory;
  }
  if (Module["buffer"]) {
   buffer = Module["buffer"];
  } else {
   {
    buffer = new ArrayBuffer(TOTAL_MEMORY);
   }
  }
  updateGlobalBufferViews();
  function getTotalMemory() {
   return TOTAL_MEMORY;
  }
  HEAP32[0] = 1668509029;
  HEAP16[1] = 25459;
  if (HEAPU8[2] !== 115 || HEAPU8[3] !== 99) throw "Runtime error: expected the system to be little-endian!";
  Module["HEAP"] = HEAP;
  Module["buffer"] = buffer;
  Module["HEAP8"] = HEAP8;
  Module["HEAP16"] = HEAP16;
  Module["HEAP32"] = HEAP32;
  Module["HEAPU8"] = HEAPU8;
  Module["HEAPU16"] = HEAPU16;
  Module["HEAPU32"] = HEAPU32;
  Module["HEAPF32"] = HEAPF32;
  Module["HEAPF64"] = HEAPF64;
  function callRuntimeCallbacks(callbacks) {
   while (callbacks.length > 0) {
    var callback = callbacks.shift();
    if (typeof callback == "function") {
     callback();
     continue;
    }
    var func = callback.func;
    if (typeof func === "number") {
     if (callback.arg === undefined) {
      Runtime.dynCall("v", func);
     } else {
      Runtime.dynCall("vi", func, [ callback.arg ]);
     }
    } else {
     func(callback.arg === undefined ? null : callback.arg);
    }
   }
  }
  var __ATPRERUN__ = [];
  var __ATINIT__ = [];
  var __ATMAIN__ = [];
  var __ATEXIT__ = [];
  var __ATPOSTRUN__ = [];
  var runtimeInitialized = false;
  function preRun() {
   if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
    while (Module["preRun"].length) {
     addOnPreRun(Module["preRun"].shift());
    }
   }
   callRuntimeCallbacks(__ATPRERUN__);
  }
  function ensureInitRuntime() {
   if (runtimeInitialized) return;
   runtimeInitialized = true;
   callRuntimeCallbacks(__ATINIT__);
  }
  function preMain() {
   callRuntimeCallbacks(__ATMAIN__);
  }
  function exitRuntime() {
   callRuntimeCallbacks(__ATEXIT__);
  }
  function postRun() {
   if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
    while (Module["postRun"].length) {
     addOnPostRun(Module["postRun"].shift());
    }
   }
   callRuntimeCallbacks(__ATPOSTRUN__);
  }
  function addOnPreRun(cb) {
   __ATPRERUN__.unshift(cb);
  }
  Module["addOnPreRun"] = addOnPreRun;
  function addOnInit(cb) {
   __ATINIT__.unshift(cb);
  }
  Module["addOnInit"] = addOnInit;
  function addOnPreMain(cb) {
   __ATMAIN__.unshift(cb);
  }
  Module["addOnPreMain"] = addOnPreMain;
  function addOnExit(cb) {
   __ATEXIT__.unshift(cb);
  }
  Module["addOnExit"] = addOnExit;
  function addOnPostRun(cb) {
   __ATPOSTRUN__.unshift(cb);
  }
  Module["addOnPostRun"] = addOnPostRun;
  function intArrayFromString(stringy, dontAddNull, length) {
   var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
   var u8array = new Array(len);
   var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
   if (dontAddNull) u8array.length = numBytesWritten;
   return u8array;
  }
  Module["intArrayFromString"] = intArrayFromString;
  function intArrayToString(array) {
   var ret = [];
   for (var i = 0; i < array.length; i++) {
    var chr = array[i];
    if (chr > 255) {
     chr &= 255;
    }
    ret.push(String.fromCharCode(chr));
   }
   return ret.join("");
  }
  Module["intArrayToString"] = intArrayToString;
  function writeStringToMemory(string, buffer, dontAddNull) {
   Runtime.warnOnce("writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!");
   var lastChar, end;
   if (dontAddNull) {
    end = buffer + lengthBytesUTF8(string);
    lastChar = HEAP8[end];
   }
   stringToUTF8(string, buffer, Infinity);
   if (dontAddNull) HEAP8[end] = lastChar;
  }
  Module["writeStringToMemory"] = writeStringToMemory;
  function writeArrayToMemory(array, buffer) {
   HEAP8.set(array, buffer);
  }
  Module["writeArrayToMemory"] = writeArrayToMemory;
  function writeAsciiToMemory(str, buffer, dontAddNull) {
   for (var i = 0; i < str.length; ++i) {
    HEAP8[buffer++ >> 0] = str.charCodeAt(i);
   }
   if (!dontAddNull) HEAP8[buffer >> 0] = 0;
  }
  Module["writeAsciiToMemory"] = writeAsciiToMemory;
  if (!Math["imul"] || Math["imul"](4294967295, 5) !== -5) Math["imul"] = function imul(a, b) {
   var ah = a >>> 16;
   var al = a & 65535;
   var bh = b >>> 16;
   var bl = b & 65535;
   return al * bl + (ah * bl + al * bh << 16) | 0;
  };
  Math.imul = Math["imul"];
  if (!Math["clz32"]) Math["clz32"] = (function(x) {
   x = x >>> 0;
   for (var i = 0; i < 32; i++) {
    if (x & 1 << 31 - i) return i;
   }
   return 32;
  });
  Math.clz32 = Math["clz32"];
  if (!Math["trunc"]) Math["trunc"] = (function(x) {
   return x < 0 ? Math.ceil(x) : Math.floor(x);
  });
  Math.trunc = Math["trunc"];
  var Math_abs = Math.abs;
  var Math_ceil = Math.ceil;
  var Math_floor = Math.floor;
  var Math_min = Math.min;
  var runDependencies = 0;
  var dependenciesFulfilled = null;
  function addRunDependency(id) {
   runDependencies++;
   if (Module["monitorRunDependencies"]) {
    Module["monitorRunDependencies"](runDependencies);
   }
  }
  Module["addRunDependency"] = addRunDependency;
  function removeRunDependency(id) {
   runDependencies--;
   if (Module["monitorRunDependencies"]) {
    Module["monitorRunDependencies"](runDependencies);
   }
   if (runDependencies == 0) {
    if (dependenciesFulfilled) {
     var callback = dependenciesFulfilled;
     dependenciesFulfilled = null;
     callback();
    }
   }
  }
  Module["removeRunDependency"] = removeRunDependency;
  Module["preloadedImages"] = {};
  Module["preloadedAudios"] = {};
  STATIC_BASE = 8;
  STATICTOP = STATIC_BASE + 1093456;
  __ATINIT__.push();
  allocate([ 0, 0, 0, 0, 1, 0, 0, 0, 148, 222, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 151, 222, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 178, 222, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 199, 222, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 225, 222, 0, 0, 5, 0, 0, 0, 1, 0, 0, 0, 247, 222, 0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 10, 223, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 37, 223, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 59, 223, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0, 77, 223, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 100, 223, 0, 0, 11, 0, 0, 0, 1, 0, 0, 0, 130, 223, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 170, 223, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0, 203, 223, 0, 0, 14, 0, 0, 0, 1, 0, 0, 0, 218, 223, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 242, 223, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 18, 224, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 45, 224, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0, 69, 224, 0, 0, 19, 0, 0, 0, 1, 0, 0, 0, 90, 224, 0, 0, 20, 0, 0, 0, 1, 0, 0, 0, 119, 224, 0, 0, 21, 0, 0, 0, 1, 0, 0, 0, 146, 224, 0, 0, 22, 0, 0, 0, 1, 0, 0, 0, 168, 224, 0, 0, 23, 0, 0, 0, 1, 0, 0, 0, 194, 224, 0, 0, 24, 0, 0, 0, 1, 0, 0, 0, 211, 224, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0, 241, 224, 0, 0, 26, 0, 0, 0, 1, 0, 0, 0, 17, 225, 0, 0, 27, 0, 0, 0, 1, 0, 0, 0, 51, 225, 0, 0, 28, 0, 0, 0, 1, 0, 0, 0, 92, 225, 0, 0, 29, 0, 0, 0, 1, 0, 0, 0, 121, 225, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 151, 225, 0, 0, 31, 0, 0, 0, 1, 0, 0, 0, 179, 225, 0, 0, 32, 0, 0, 0, 1, 0, 0, 0, 206, 225, 0, 0, 33, 0, 0, 0, 1, 0, 0, 0, 233, 225, 0, 0, 34, 0, 0, 0, 1, 0, 0, 0, 8, 226, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 45, 226, 0, 0, 10, 0, 0, 0, 1, 0, 0, 0, 106, 241, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 112, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 117, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 125, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 129, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 133, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 189, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 137, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 142, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 147, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 42, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 152, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 155, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 159, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 165, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 169, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 174, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, 0, 179, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 0, 0, 0, 185, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 196, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 200, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 202, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 206, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 18, 0, 0, 0, 210, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19, 0, 0, 0, 214, 241, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 219, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 0, 0, 0, 225, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 0, 0, 0, 233, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 0, 0, 0, 242, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 245, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 0, 0, 0, 250, 241, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 242, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 4, 242, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27, 0, 0, 0, 11, 242, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28, 0, 0, 0, 18, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 0, 0, 0, 23, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 0, 0, 0, 33, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 31, 0, 0, 0, 40, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 91, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 58, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 137, 0, 0, 0, 153, 0, 0, 0, 169, 0, 0, 0, 185, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 108, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 201, 0, 0, 0, 217, 0, 0, 0, 233, 0, 0, 0, 249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 113, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 139, 0, 0, 0, 155, 0, 0, 0, 171, 0, 0, 0, 187, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 118, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 203, 0, 0, 0, 219, 0, 0, 0, 235, 0, 0, 0, 251, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 123, 244, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 195, 0, 0, 0, 211, 0, 0, 0, 227, 0, 0, 0, 243, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 128, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 132, 0, 0, 0, 148, 0, 0, 0, 164, 0, 0, 0, 180, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 133, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 196, 0, 0, 0, 212, 0, 0, 0, 228, 0, 0, 0, 244, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 204, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 133, 0, 0, 0, 149, 0, 0, 0, 165, 0, 0, 0, 181, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 209, 244, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 197, 0, 0, 0, 213, 0, 0, 0, 229, 0, 0, 0, 245, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 242, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 252, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 200, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 180, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 218, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 188, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 192, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 196, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 214, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 222, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 226, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 230, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 234, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 15, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 19, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 238, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 11, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 141, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 27, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 45, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 79, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 83, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 87, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 145, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 158, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 247, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 111, 0, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 35, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 79, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 40, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 49, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 129, 0, 0, 0, 145, 0, 0, 0, 161, 0, 0, 0, 177, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 54, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 193, 0, 0, 0, 209, 0, 0, 0, 225, 0, 0, 0, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 23, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 247, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 99, 0, 0, 0, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 67, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 64, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 231, 245, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 96, 0, 0, 0, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 221, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 226, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 81, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 245, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 106, 0, 0, 0, 122, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 85, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 74, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 90, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 111, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 136, 0, 0, 0, 152, 0, 0, 0, 168, 0, 0, 0, 184 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE);
  allocate([ 32, 0, 0, 0, 116, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 200, 0, 0, 0, 216, 0, 0, 0, 232, 0, 0, 0, 248, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 51, 247, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 108, 0, 0, 0, 124, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 131, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 76, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 136, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 247, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 110, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 245, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 157, 0, 0, 0, 173, 0, 0, 0, 189, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 153, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 134, 0, 0, 0, 150, 0, 0, 0, 166, 0, 0, 0, 182, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 158, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 198, 0, 0, 0, 214, 0, 0, 0, 230, 0, 0, 0, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 163, 245, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 204, 0, 0, 0, 220, 0, 0, 0, 236, 0, 0, 0, 252, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 217, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 235, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 138, 0, 0, 0, 154, 0, 0, 0, 170, 0, 0, 0, 186, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 240, 245, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 202, 0, 0, 0, 218, 0, 0, 0, 234, 0, 0, 0, 250, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 245, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 54, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 250, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 255, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 19, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 56, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 9, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 14, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 39, 246, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 105, 0, 0, 0, 121, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 29, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 73, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 34, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 53, 246, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 102, 0, 0, 0, 118, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 43, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 48, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 57, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 59, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 61, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 137, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 192, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 148, 244, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 104, 0, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 189, 245, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 104, 0, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 138, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 143, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 152, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 179, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 193, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 244, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 103, 0, 0, 0, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 157, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 162, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 73, 245, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 140, 0, 0, 0, 156, 0, 0, 0, 172, 0, 0, 0, 188, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 99, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 55, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 245, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 206, 0, 0, 0, 222, 0, 0, 0, 238, 0, 0, 0, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 245, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 142, 0, 0, 0, 158, 0, 0, 0, 174, 0, 0, 0, 190, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 208, 245, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 100, 0, 0, 0, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 198, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 68, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 203, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 212, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 91, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 151, 0, 0, 0, 167, 0, 0, 0, 183, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 215, 0, 0, 0, 231, 0, 0, 0, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 101, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 221, 0, 0, 0, 237, 0, 0, 0, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 110, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 159, 0, 0, 0, 175, 0, 0, 0, 191, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 114, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 223, 0, 0, 0, 239, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 122, 246, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 128, 0, 0, 0, 144, 0, 0, 0, 160, 0, 0, 0, 176, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 127, 246, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 192, 0, 0, 0, 208, 0, 0, 0, 224, 0, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 132, 246, 0, 0, 0, 0, 0, 0, 92, 0, 0, 0, 131, 0, 0, 0, 147, 0, 0, 0, 163, 0, 0, 0, 179, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 65, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 69, 246, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 130, 0, 0, 0, 146, 0, 0, 0, 162, 0, 0, 0, 178, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 74, 246, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 194, 0, 0, 0, 210, 0, 0, 0, 226, 0, 0, 0, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 172, 246, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 109, 0, 0, 0, 125, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 162, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 93, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 176, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 53, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 81, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 85, 243, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 113, 0, 0, 0, 97, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 89, 243, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 114, 0, 0, 0, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 93, 243, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 117, 0, 0, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 97, 243, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 123, 0, 0, 0, 107, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 196, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 219, 246, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 105, 0, 0, 0, 101, 0, 0, 0, 117, 0, 0, 0, 109, 0, 0, 0, 125, 0, 0, 0, 121, 0, 0, 0, 97, 0, 0, 0, 113, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 101, 243, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 213, 243, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 41, 0, 0, 0, 37, 0, 0, 0, 53, 0, 0, 0, 45, 0, 0, 0, 61, 0, 0, 0, 57, 0, 0, 0, 33, 0, 0, 0, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 105, 243, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 139, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 109, 243, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 107, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 148, 244, 0, 0, 0, 0, 0, 0, 217, 0, 0, 0, 10, 0, 0, 0, 6, 0, 0, 0, 22, 0, 0, 0, 14, 0, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 244, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 144, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 180, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 176, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 245, 243, 0, 0, 0, 0, 0, 0, 72, 0, 0, 0, 36, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 230, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 234, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 208, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 238, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 113, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 15, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 19, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 27, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 117, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 216, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 45, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 6, 244, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 201, 0, 0, 0, 197, 0, 0, 0, 213, 0, 0, 0, 205, 0, 0, 0, 221, 0, 0, 0, 217, 0, 0, 0, 193, 0, 0, 0, 209 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 10256);
  allocate([ 32, 0, 0, 0, 73, 245, 0, 0, 0, 0, 0, 0, 74, 0, 0, 0, 224, 0, 0, 0, 228, 0, 0, 0, 236, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 77, 245, 0, 0, 0, 0, 0, 0, 74, 0, 0, 0, 192, 0, 0, 0, 196, 0, 0, 0, 204, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 121, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 199, 0, 0, 0, 215, 0, 0, 0, 207, 0, 0, 0, 223, 0, 0, 0, 219, 0, 0, 0, 195, 0, 0, 0, 211, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 245, 0, 0, 0, 0, 0, 0, 216, 0, 0, 0, 198, 0, 0, 0, 214, 0, 0, 0, 206, 0, 0, 0, 222, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 202, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 107, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 136, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 20, 244, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 73, 0, 0, 0, 69, 0, 0, 0, 85, 0, 0, 0, 77, 0, 0, 0, 93, 0, 0, 0, 89, 0, 0, 0, 65, 0, 0, 0, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 51, 247, 0, 0, 0, 0, 0, 0, 216, 0, 0, 0, 230, 0, 0, 0, 246, 0, 0, 0, 238, 0, 0, 0, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 232, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 145, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 125, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 231, 0, 0, 0, 247, 0, 0, 0, 239, 0, 0, 0, 255, 0, 0, 0, 251, 0, 0, 0, 227, 0, 0, 0, 243, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 247, 0, 0, 0, 0, 0, 0, 64, 16, 0, 0, 76, 0, 0, 0, 108, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 245, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 129, 243, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 187, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 133, 243, 0, 0, 0, 0, 0, 0, 104, 13, 0, 0, 167, 0, 0, 0, 183, 0, 0, 0, 175, 0, 0, 0, 191, 0, 0, 0, 163, 0, 0, 0, 179, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 29, 244, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 169, 0, 0, 0, 165, 0, 0, 0, 181, 0, 0, 0, 173, 0, 0, 0, 189, 0, 0, 0, 185, 0, 0, 0, 161, 0, 0, 0, 177, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 245, 0, 0, 0, 0, 0, 0, 106, 1, 0, 0, 162, 0, 0, 0, 166, 0, 0, 0, 182, 0, 0, 0, 174, 0, 0, 0, 190, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 175, 245, 0, 0, 0, 0, 0, 0, 218, 0, 0, 0, 160, 0, 0, 0, 164, 0, 0, 0, 180, 0, 0, 0, 172, 0, 0, 0, 188, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 208, 245, 0, 0, 0, 0, 0, 0, 217, 0, 0, 0, 74, 0, 0, 0, 70, 0, 0, 0, 86, 0, 0, 0, 78, 0, 0, 0, 94, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 137, 243, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 171, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 247, 0, 0, 0, 0, 0, 0, 219, 0, 0, 0, 234, 0, 0, 0, 128, 0, 0, 0, 4, 0, 0, 0, 20, 0, 0, 0, 12, 0, 0, 0, 28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 48, 244, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 9, 0, 0, 0, 5, 0, 0, 0, 21, 0, 0, 0, 13, 0, 0, 0, 29, 0, 0, 0, 25, 0, 0, 0, 1, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 145, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 153, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 157, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 39, 0, 0, 0, 55, 0, 0, 0, 47, 0, 0, 0, 63, 0, 0, 0, 59, 0, 0, 0, 35, 0, 0, 0, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 39, 246, 0, 0, 0, 0, 0, 0, 217, 0, 0, 0, 42, 0, 0, 0, 38, 0, 0, 0, 54, 0, 0, 0, 46, 0, 0, 0, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 53, 246, 0, 0, 0, 0, 0, 0, 217, 0, 0, 0, 106, 0, 0, 0, 102, 0, 0, 0, 118, 0, 0, 0, 110, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 161, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 103, 0, 0, 0, 119, 0, 0, 0, 111, 0, 0, 0, 127, 0, 0, 0, 123, 0, 0, 0, 99, 0, 0, 0, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 57, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 61, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 165, 243, 0, 0, 0, 0, 0, 0, 104, 4, 0, 0, 135, 0, 0, 0, 151, 0, 0, 0, 143, 0, 0, 0, 131, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 66, 244, 0, 0, 0, 0, 0, 0, 218, 13, 0, 0, 233, 0, 0, 0, 229, 0, 0, 0, 245, 0, 0, 0, 237, 0, 0, 0, 253, 0, 0, 0, 249, 0, 0, 0, 225, 0, 0, 0, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 169, 243, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 203, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 79, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 56, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 173, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 248, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 83, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 177, 243, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 159, 0, 0, 0, 147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 181, 243, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 155, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 185, 243, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 158, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 189, 243, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 156, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 193, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 7, 0, 0, 0, 23, 0, 0, 0, 15, 0, 0, 0, 31, 0, 0, 0, 27, 0, 0, 0, 3, 0, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 197, 243, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 71, 0, 0, 0, 87, 0, 0, 0, 79, 0, 0, 0, 95, 0, 0, 0, 91, 0, 0, 0, 67, 0, 0, 0, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 70, 244, 0, 0, 0, 0, 0, 0, 216, 13, 0, 0, 133, 0, 0, 0, 149, 0, 0, 0, 141, 0, 0, 0, 157, 0, 0, 0, 153, 0, 0, 0, 129, 0, 0, 0, 145, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 114, 246, 0, 0, 0, 0, 0, 0, 104, 0, 0, 0, 134, 0, 0, 0, 150, 0, 0, 0, 142, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 118, 246, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 132, 0, 0, 0, 148, 0, 0, 0, 140, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 78, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 170, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 201, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 168, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 176, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 186, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 87, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 138, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 154, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 205, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 152, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 219, 246, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 169, 0, 0, 0, 185, 0, 0, 0, 233, 0, 0, 0, 201, 0, 0, 0, 217, 0, 0, 0, 249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 209, 243, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 171, 0, 0, 0, 187, 0, 0, 0, 235, 0, 0, 0, 203, 0, 0, 0, 219, 0, 0, 0, 251, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 213, 243, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 164, 0, 0, 0, 180, 0, 0, 0, 228, 0, 0, 0, 196, 0, 0, 0, 212, 0, 0, 0, 244, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 148, 244, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 72, 0, 0, 0, 56, 0, 0, 0, 104, 0, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 138, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 217, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 244, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 71, 0, 0, 0, 55, 0, 0, 0, 103, 0, 0, 0, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 157, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 222, 243, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 175, 244, 0, 0, 64, 0, 0, 0, 0, 128, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 180, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 227, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 232, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 196, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 200, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 237, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 241, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 245, 243, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 165, 0, 0, 0, 181, 0, 0, 0, 229, 0, 0, 0, 197, 0, 0, 0, 213, 0, 0, 0, 245, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 218, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 222, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 249, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 230, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 253, 243, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 234, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 238, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 242, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 252, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 246, 244, 0, 0, 96, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 245, 0, 0, 96, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 6, 245, 0, 0, 64, 0, 0, 0, 0, 128, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 11, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 173, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 27, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 152, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 154, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 247, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 79, 0, 0, 0, 63, 0, 0, 0, 111, 0, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 35, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 79, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 1, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 6, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 161, 0, 0, 0, 177, 0, 0, 0, 225, 0, 0, 0, 193, 0, 0, 0, 209, 0, 0, 0, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 247, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 67, 0, 0, 0, 51, 0, 0, 0, 99, 0, 0, 0, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 67, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 10, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 73, 245, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 163, 0, 0, 0, 179, 0, 0, 0, 227, 0, 0, 0, 195, 0, 0, 0, 211, 0, 0, 0, 243, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 245, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 74, 0, 0, 0, 58, 0, 0, 0, 106, 0, 0, 0, 122, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 85, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 74 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 20552);
  allocate([ 32, 0, 0, 0, 15, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 20, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 168, 0, 0, 0, 184, 0, 0, 0, 232, 0, 0, 0, 200, 0, 0, 0, 216, 0, 0, 0, 248, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 51, 247, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 76, 0, 0, 0, 60, 0, 0, 0, 108, 0, 0, 0, 124, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 131, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 76, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 247, 0, 0, 0, 0, 0, 0, 216, 32, 0, 0, 188, 0, 0, 0, 236, 0, 0, 0, 204, 0, 0, 0, 220, 0, 0, 0, 252, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 245, 0, 0, 0, 0, 0, 0, 216, 32, 0, 0, 189, 0, 0, 0, 237, 0, 0, 0, 205, 0, 0, 0, 221, 0, 0, 0, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 29, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 166, 0, 0, 0, 182, 0, 0, 0, 230, 0, 0, 0, 198, 0, 0, 0, 214, 0, 0, 0, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 245, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 174, 0, 0, 0, 190, 0, 0, 0, 238, 0, 0, 0, 206, 0, 0, 0, 222, 0, 0, 0, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 189, 245, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 72, 0, 0, 0, 56, 0, 0, 0, 104, 0, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 179, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 33, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 208, 245, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 68, 0, 0, 0, 52, 0, 0, 0, 100, 0, 0, 0, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 198, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 68, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 38, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 231, 245, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 64, 0, 0, 0, 48, 0, 0, 0, 96, 0, 0, 0, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 221, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 43, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 157, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 48, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 170, 0, 0, 0, 186, 0, 0, 0, 234, 0, 0, 0, 202, 0, 0, 0, 218, 0, 0, 0, 250, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 39, 246, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 73, 0, 0, 0, 57, 0, 0, 0, 105, 0, 0, 0, 121, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 29, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 73, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 52, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 53, 246, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 70, 0, 0, 0, 54, 0, 0, 0, 102, 0, 0, 0, 118, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 43, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 57, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 62, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 156, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 57, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 61, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 129, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 66, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 162, 0, 0, 0, 178, 0, 0, 0, 226, 0, 0, 0, 194, 0, 0, 0, 210, 0, 0, 0, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 79, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 153, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 83, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 155, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 70, 244, 0, 0, 0, 0, 0, 0, 216, 32, 0, 0, 183, 0, 0, 0, 231, 0, 0, 0, 199, 0, 0, 0, 215, 0, 0, 0, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 114, 246, 0, 0, 0, 0, 0, 0, 216, 32, 0, 0, 191, 0, 0, 0, 239, 0, 0, 0, 207, 0, 0, 0, 223, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 74, 244, 0, 0, 0, 0, 0, 0, 218, 32, 0, 0, 160, 0, 0, 0, 176, 0, 0, 0, 224, 0, 0, 0, 192, 0, 0, 0, 208, 0, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 137, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 131, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 78, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 151, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 172, 246, 0, 0, 0, 0, 0, 0, 25, 32, 0, 0, 77, 0, 0, 0, 61, 0, 0, 0, 109, 0, 0, 0, 125, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 162, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 82, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 93, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 87, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 159, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 91, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 58, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 99, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 58, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 137, 0, 0, 0, 153, 0, 0, 0, 169, 0, 0, 0, 169, 24, 0, 0, 185, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 108, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 201, 0, 0, 0, 217, 0, 0, 0, 233, 0, 0, 0, 233, 24, 0, 0, 249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 113, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 139, 0, 0, 0, 155, 0, 0, 0, 171, 0, 0, 0, 171, 24, 0, 0, 187, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 118, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 203, 0, 0, 0, 219, 0, 0, 0, 235, 0, 0, 0, 235, 24, 0, 0, 251, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 123, 244, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 195, 0, 0, 0, 211, 0, 0, 0, 227, 0, 0, 0, 227, 24, 0, 0, 243, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 128, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 132, 0, 0, 0, 148, 0, 0, 0, 164, 0, 0, 0, 164, 24, 0, 0, 180, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 133, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 196, 0, 0, 0, 212, 0, 0, 0, 228, 0, 0, 0, 228, 24, 0, 0, 244, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 138, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 143, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 148, 244, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 104, 0, 0, 0, 104, 24, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 152, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 157, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 162, 244, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 244, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 103, 0, 0, 0, 103, 24, 0, 0, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 175, 244, 0, 0, 16, 0, 0, 0, 56, 0, 0, 0, 21, 0, 0, 0, 29, 0, 0, 0, 29, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 180, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 188, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 192, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 196, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 200, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 204, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 133, 0, 0, 0, 149, 0, 0, 0, 165, 0, 0, 0, 165, 24, 0, 0, 181, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 209, 244, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 197, 0, 0, 0, 213, 0, 0, 0, 229, 0, 0, 0, 229, 24, 0, 0, 245, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 214, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 218, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 222, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 226, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 230, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 234, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 238, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 242, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 246, 244, 0, 0, 48, 0, 0, 0, 56, 0, 0, 0, 19, 0, 0, 0, 31, 0, 0, 0, 31, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 252, 244, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 245, 0, 0, 48, 0, 0, 0, 56, 0, 0, 0, 18, 0, 0, 0, 30, 0, 0, 0, 30, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 6, 245, 0, 0, 16, 0, 0, 0, 56, 0, 0, 0, 20, 0, 0, 0, 28, 0, 0, 0, 28, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 11, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 141, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 15, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 19, 245, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 23, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 27, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 35, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 79, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 40, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 247, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 111, 0, 0, 0, 111, 24, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 45, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 49, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 129, 0, 0, 0, 145, 0, 0, 0, 161, 0, 0, 0, 161, 24, 0, 0, 177, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 54, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 193, 0, 0, 0, 209, 0, 0, 0, 225, 0, 0, 0, 225, 24, 0, 0, 241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 67, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 64, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 247, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 99, 0, 0, 0, 99, 24, 0, 0, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 69, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 131, 26, 0, 0, 147, 26, 0, 0, 163, 26, 0, 0, 163, 205, 0, 0, 179, 26 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 30848);
  allocate([ 32, 0, 0, 0, 73, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 140, 0, 0, 0, 156, 0, 0, 0, 172, 0, 0, 0, 172, 205, 0, 0, 188, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 77, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 140, 24, 0, 0, 156, 24, 0, 0, 172, 26, 0, 0, 172, 24, 0, 0, 188, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 81, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 85, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 74, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 90, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 95, 245, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 106, 0, 0, 0, 106, 24, 0, 0, 122, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 99, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 103, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 107, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 9, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 111, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 136, 0, 0, 0, 152, 0, 0, 0, 168, 0, 0, 0, 168, 24, 0, 0, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 116, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 200, 0, 0, 0, 216, 0, 0, 0, 232, 0, 0, 0, 232, 24, 0, 0, 248, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 121, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 126, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 131, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 76, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 136, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 51, 247, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 108, 0, 0, 0, 108, 24, 0, 0, 124, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 55, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 145, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 8, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 59, 247, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 110, 0, 0, 0, 110, 24, 0, 0, 126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 245, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 157, 0, 0, 0, 173, 0, 0, 0, 173, 24, 0, 0, 189, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 153, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 134, 0, 0, 0, 150, 0, 0, 0, 166, 0, 0, 0, 166, 24, 0, 0, 182, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 158, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 198, 0, 0, 0, 214, 0, 0, 0, 230, 0, 0, 0, 230, 24, 0, 0, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 163, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 204, 0, 0, 0, 220, 0, 0, 0, 236, 0, 0, 0, 236, 24, 0, 0, 252, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 142, 0, 0, 0, 158, 0, 0, 0, 174, 0, 0, 0, 174, 24, 0, 0, 190, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 171, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 206, 0, 0, 0, 222, 0, 0, 0, 238, 0, 0, 0, 238, 205, 0, 0, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 175, 245, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 206, 24, 0, 0, 222, 24, 0, 0, 238, 26, 0, 0, 238, 24, 0, 0, 254, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 179, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 189, 245, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 104, 0, 0, 0, 104, 24, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 193, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 198, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 68, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 203, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 208, 245, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 100, 0, 0, 0, 100, 24, 0, 0, 116, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 212, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 217, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 221, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 226, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 231, 245, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 96, 0, 0, 0, 96, 24, 0, 0, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 235, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 138, 0, 0, 0, 154, 0, 0, 0, 170, 0, 0, 0, 170, 24, 0, 0, 186, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 240, 245, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 202, 0, 0, 0, 218, 0, 0, 0, 234, 0, 0, 0, 234, 24, 0, 0, 250, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 245, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 54, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 250, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 255, 245, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 4, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 60, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 9, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 14, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 19, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 56, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 56, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 29, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 73, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 34, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 39, 246, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 105, 0, 0, 0, 105, 24, 0, 0, 121, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 43, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 48, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 53, 246, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 102, 0, 0, 0, 102, 24, 0, 0, 118, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 57, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 59, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 61, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 65, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 69, 246, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 130, 0, 0, 0, 146, 0, 0, 0, 162, 0, 0, 0, 162, 24, 0, 0, 178, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 74, 246, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 194, 0, 0, 0, 210, 0, 0, 0, 226, 0, 0, 0, 226, 24, 0, 0, 242, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 79, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 83, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 87, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 91, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 151, 0, 0, 0, 167, 0, 0, 0, 167, 24, 0, 0, 183, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 215, 0, 0, 0, 231, 0, 0, 0, 231, 24, 0, 0, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 101, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 221, 0, 0, 0, 237, 0, 0, 0, 237, 24, 0, 0, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 105, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 207, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 110, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 159, 0, 0, 0, 175, 0, 0, 0, 175, 24, 0, 0, 191, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 114, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 223, 0, 0, 0, 239, 0, 0, 0, 239, 205, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 118, 246, 0, 0, 0, 0, 0, 0, 120, 0, 0, 0, 223, 24, 0, 0, 239, 26, 0, 0, 239, 24, 0, 0, 255, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 122, 246, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 128, 0, 0, 0, 144, 0, 0, 0, 160, 0, 0, 0, 160, 24, 0, 0, 176, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 127, 246, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 192, 0, 0, 0, 208, 0, 0, 0, 224, 0, 0, 0, 224, 24, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 132, 246, 0, 0, 0, 0, 0, 0, 124, 0, 0, 0, 131, 0, 0, 0, 147, 0, 0, 0, 163, 0, 0, 0, 163, 24, 0, 0, 179, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 137, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 141, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 145, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 149, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 153, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 158, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 162, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 167, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 93, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 172, 246, 0, 0, 0, 0, 0, 0, 112, 0, 0, 0, 109, 0, 0, 0, 109, 24, 0, 0, 125, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 176, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 180, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 48, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 184, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 53, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 188, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 53, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 192, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 196, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 143, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 201, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 143, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 206, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 210, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 213, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 216, 246, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 219, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 142, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 223, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 226, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 136, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 229, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 137 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 41144);
  allocate([ 34, 0, 0, 0, 233, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 236, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 208, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 240, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 130, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36, 0, 0, 0, 243, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 144, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 246, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 145, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 249, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 146, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 253, 246, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 152, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 1, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 148, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 5, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 129, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 8, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 144, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 11, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 143, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36, 0, 0, 0, 15, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 0, 0, 0, 18, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 132, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 21, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 24, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 28, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 141, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 31, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37, 0, 0, 0, 35, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 39, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 42, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 45, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 48, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 51, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 0, 55, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 160, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37, 0, 0, 0, 59, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 63, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 39, 0, 0, 0, 66, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 70, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 75, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 80, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 83, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 41, 0, 0, 0, 87, 247, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 90, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 93, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 138, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 96, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 100, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 103, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 106, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 139, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 109, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 0, 113, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 176, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37, 0, 0, 0, 118, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 121, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 124, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 128, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 131, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 134, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 137, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 141, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 144, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 140, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 147, 247, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 224, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 176, 221, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 76, 171, 16, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 176, 221, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 79, 75, 0, 67, 104, 101, 99, 107, 32, 99, 111, 109, 109, 97, 110, 100, 45, 108, 105, 110, 101, 32, 102, 111, 114, 109, 97, 116, 46, 0, 85, 110, 97, 98, 108, 101, 32, 116, 111, 32, 111, 112, 101, 110, 32, 102, 105, 108, 101, 46, 0, 83, 111, 117, 114, 99, 101, 32, 105, 115, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 97, 98, 108, 101, 46, 0, 84, 111, 111, 32, 109, 97, 110, 121, 32, 112, 97, 115, 115, 101, 115, 32, 40, 37, 115, 41, 46, 0, 83, 121, 110, 116, 97, 120, 32, 69, 114, 114, 111, 114, 32, 39, 37, 115, 39, 46, 0, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 116, 97, 98, 108, 101, 32, 111, 118, 101, 114, 102, 108, 111, 119, 46, 0, 85, 110, 98, 97, 108, 97, 110, 99, 101, 100, 32, 66, 114, 97, 99, 101, 115, 32, 91, 93, 46, 0, 68, 105, 118, 105, 115, 105, 111, 110, 32, 98, 121, 32, 122, 101, 114, 111, 46, 0, 85, 110, 107, 110, 111, 119, 110, 32, 77, 110, 101, 109, 111, 110, 105, 99, 32, 39, 37, 115, 39, 46, 0, 73, 108, 108, 101, 103, 97, 108, 32, 65, 100, 100, 114, 101, 115, 115, 105, 110, 103, 32, 109, 111, 100, 101, 32, 39, 37, 115, 39, 46, 0, 73, 108, 108, 101, 103, 97, 108, 32, 102, 111, 114, 99, 101, 100, 32, 65, 100, 100, 114, 101, 115, 115, 105, 110, 103, 32, 109, 111, 100, 101, 32, 111, 110, 32, 39, 37, 115, 39, 46, 0, 78, 111, 116, 32, 101, 110, 111, 117, 103, 104, 32, 97, 114, 103, 115, 32, 112, 97, 115, 115, 101, 100, 32, 116, 111, 32, 77, 97, 99, 114, 111, 46, 0, 80, 114, 101, 109, 97, 116, 117, 114, 101, 32, 69, 79, 70, 46, 0, 73, 108, 108, 101, 103, 97, 108, 32, 99, 104, 97, 114, 97, 99, 116, 101, 114, 32, 39, 37, 115, 39, 46, 0, 66, 114, 97, 110, 99, 104, 32, 111, 117, 116, 32, 111, 102, 32, 114, 97, 110, 103, 101, 32, 40, 37, 115, 32, 98, 121, 116, 101, 115, 41, 46, 0, 69, 82, 82, 32, 112, 115, 101, 117, 100, 111, 45, 111, 112, 32, 101, 110, 99, 111, 117, 110, 116, 101, 114, 101, 100, 46, 0, 79, 114, 105, 103, 105, 110, 32, 82, 101, 118, 101, 114, 115, 101, 45, 105, 110, 100, 101, 120, 101, 100, 46, 0, 69, 81, 85, 58, 32, 86, 97, 108, 117, 101, 32, 109, 105, 115, 109, 97, 116, 99, 104, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 60, 36, 49, 48, 48, 46, 0, 73, 108, 108, 101, 103, 97, 108, 32, 98, 105, 116, 32, 115, 112, 101, 99, 105, 102, 105, 99, 97, 116, 105, 111, 110, 46, 0, 78, 111, 116, 32, 101, 110, 111, 117, 103, 104, 32, 97, 114, 103, 117, 109, 101, 110, 116, 115, 46, 0, 76, 97, 98, 101, 108, 32, 109, 105, 115, 109, 97, 116, 99, 104, 46, 46, 46, 10, 32, 45, 45, 62, 32, 37, 115, 0, 86, 97, 108, 117, 101, 32, 85, 110, 100, 101, 102, 105, 110, 101, 100, 46, 0, 80, 114, 111, 99, 101, 115, 115, 111, 114, 32, 39, 37, 115, 39, 32, 110, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 46, 0, 82, 69, 80, 69, 65, 84, 32, 112, 97, 114, 97, 109, 101, 116, 101, 114, 32, 60, 32, 48, 32, 40, 105, 103, 110, 111, 114, 101, 100, 41, 46, 0, 66, 97, 100, 32, 101, 114, 114, 111, 114, 32, 118, 97, 108, 117, 101, 32, 40, 105, 110, 116, 101, 114, 110, 97, 108, 32, 101, 114, 114, 111, 114, 41, 46, 0, 79, 110, 108, 121, 32, 111, 110, 101, 32, 112, 114, 111, 99, 101, 115, 115, 111, 114, 32, 116, 121, 112, 101, 32, 109, 97, 121, 32, 98, 101, 32, 115, 101, 108, 101, 99, 116, 101, 100, 46, 0, 66, 97, 100, 32, 111, 117, 116, 112, 117, 116, 32, 102, 111, 114, 109, 97, 116, 32, 115, 112, 101, 99, 105, 102, 105, 101, 100, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 49, 32, 111, 114, 32, 52, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 60, 36, 49, 48, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 60, 36, 56, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 60, 36, 102, 46, 0, 86, 97, 108, 117, 101, 32, 105, 110, 32, 39, 37, 115, 39, 32, 109, 117, 115, 116, 32, 98, 101, 32, 60, 36, 49, 48, 48, 48, 48, 46, 0, 73, 108, 108, 101, 103, 97, 108, 32, 99, 111, 109, 98, 105, 110, 97, 116, 105, 111, 110, 32, 111, 102, 32, 111, 112, 101, 114, 97, 110, 100, 115, 32, 39, 37, 115, 39, 0, 68, 111, 104, 33, 32, 73, 110, 116, 101, 114, 110, 97, 108, 32, 101, 110, 100, 45, 111, 102, 45, 116, 97, 98, 108, 101, 32, 109, 97, 114, 107, 101, 114, 44, 32, 114, 101, 112, 111, 114, 116, 32, 116, 104, 101, 32, 98, 117, 103, 33, 0, 37, 48, 52, 108, 120, 32, 0, 63, 63, 63, 63, 32, 0, 32, 32, 32, 32, 32, 0, 115, 116, 114, 32, 0, 32, 32, 32, 32, 0, 101, 113, 109, 32, 0, 40, 0, 82, 0, 83, 0, 41, 0, 37, 48, 56, 108, 120, 32, 37, 115, 10, 0, 66, 97, 100, 32, 101, 114, 114, 111, 114, 32, 69, 82, 82, 79, 82, 33, 0, 37, 115, 32, 40, 37, 108, 117, 41, 58, 32, 101, 114, 114, 111, 114, 58, 32, 0, 108, 105, 110, 101, 32, 37, 55, 108, 100, 32, 37, 45, 49, 48, 115, 32, 0, 37, 115, 58, 37, 108, 117, 58, 32, 101, 114, 114, 111, 114, 58, 32, 0, 73, 110, 118, 97, 108, 105, 100, 32, 101, 114, 114, 111, 114, 32, 102, 111, 114, 109, 97, 116, 44, 32, 105, 110, 116, 101, 114, 110, 97, 108, 32, 101, 114, 114, 111, 114, 33, 0, 37, 115, 10, 0, 65, 98, 111, 114, 116, 105, 110, 103, 32, 97, 115, 115, 101, 109, 98, 108, 121, 10, 0, 109, 97, 99, 114, 111, 32, 116, 97, 105, 108, 58, 32, 39, 37, 115, 39, 10, 0, 101, 110, 100, 32, 98, 114, 97, 99, 101, 32, 114, 101, 113, 117, 105, 114, 101, 100, 0, 97, 100, 100, 47, 115, 116, 114, 58, 32, 37, 100, 32, 39, 37, 115, 39, 10, 0, 115, 116, 114, 108, 105, 115, 116, 58, 32, 39, 37, 115, 39, 32, 37, 122, 117, 10, 0, 115, 116, 114, 32, 37, 56, 108, 100, 32, 98, 117, 102, 32, 37, 56, 108, 100, 32, 40, 97, 100, 100, 47, 115, 116, 114, 108, 101, 110, 40, 115, 116, 114, 41, 41, 58, 32, 37, 100, 32, 37, 108, 100, 10, 0, 102, 97, 105, 108, 117, 114, 101, 49, 0, 102, 97, 105, 108, 117, 114, 101, 50, 0, 102, 97, 105, 108, 117, 114, 101, 32, 51, 0, 117, 110, 97, 98, 108, 101, 32, 116, 111, 32, 109, 97, 108, 108, 111, 99, 0, 115, 111, 102, 116, 119, 97, 114, 101, 32, 101, 114, 114, 111, 114, 0, 37, 55, 108, 100, 32, 37, 99, 37, 115, 0, 37, 48, 50, 120, 32, 0, 37, 99, 37, 45, 49, 48, 115, 32, 37, 115, 37, 115, 37, 115, 9, 37, 115, 10, 0, 9, 59, 37, 115, 0, 114, 0, 37, 46, 42, 115, 32, 73, 110, 99, 108, 117, 100, 105, 110, 103, 32, 102, 105, 108, 101, 32, 34, 37, 115, 34, 10, 0, 45, 45, 45, 45, 45, 45, 45, 32, 70, 73, 76, 69, 32, 37, 115, 32, 76, 69, 86, 69, 76, 32, 37, 100, 32, 80, 65, 83, 83, 32, 37, 100, 10, 0, 87, 97, 114, 110, 105, 110, 103, 58, 32, 85, 110, 97, 98, 108, 101, 32, 116, 111, 32, 111, 112, 101, 110, 32, 39, 37, 115, 39, 10, 0, 70, 97, 116, 97, 108, 32, 97, 115, 115, 101, 109, 98, 108, 121, 32, 101, 114, 114, 111, 114, 58, 32, 37, 115, 10, 0, 87, 97, 114, 110, 105, 110, 103, 58, 32, 85, 110, 97, 98, 108, 101, 32, 116, 111, 32, 111, 112, 101, 110, 32, 83, 121, 109, 98, 111, 108, 32, 68, 117, 109, 112, 32, 102, 105, 108, 101, 32, 39, 37, 115, 39, 10, 0, 45, 45, 45, 32, 83, 121, 109, 98, 111, 108, 32, 76, 105, 115, 116, 0, 32, 40, 117, 110, 115, 111, 114, 116, 101, 100, 32, 45, 32, 110, 111, 116, 32, 101, 110, 111, 117, 103, 104, 32, 109, 101, 109, 111, 114, 121, 32, 116, 111, 32, 115, 111, 114, 116, 33, 41, 10, 0, 37, 45, 50, 52, 115, 32, 37, 115, 10, 0, 32, 40, 115, 111, 114, 116, 101, 100, 32, 98, 121, 32, 97, 100, 100, 114, 101, 115, 115, 41, 10, 0, 32, 40, 115, 111, 114, 116, 101, 100, 32, 98, 121, 32, 115, 121, 109, 98, 111, 108, 41, 10, 0, 37, 45, 50, 52, 115, 32, 37, 45, 49, 50, 115, 0, 32, 34, 37, 115, 34, 0, 45, 45, 45, 32, 69, 110, 100, 32, 111, 102, 32, 83, 121, 109, 98, 111, 108, 32, 76, 105, 115, 116, 46, 10, 0, 68, 65, 83, 77, 32, 50, 46, 50, 48, 46, 49, 49, 32, 50, 48, 49, 52, 48, 51, 48, 52, 0, 67, 111, 112, 121, 114, 105, 103, 104, 116, 32, 40, 99, 41, 32, 49, 57, 56, 56, 45, 50, 48, 48, 56, 32, 98, 121, 32, 118, 97, 114, 105, 111, 117, 115, 32, 97, 117, 116, 104, 111, 114, 115, 32, 40, 115, 101, 101, 32, 102, 105, 108, 101, 32, 65, 85, 84, 72, 79, 82, 83, 41, 46, 0, 76, 105, 99, 101, 110, 115, 101, 32, 71, 80, 76, 118, 50, 43, 58, 32, 71, 78, 85, 32, 71, 80, 76, 32, 118, 101, 114, 115, 105, 111, 110, 32, 50, 32, 111, 114, 32, 108, 97, 116, 101, 114, 32, 40, 115, 101, 101, 32, 102, 105, 108, 101, 32, 67, 79, 80, 89, 73, 78, 71, 41, 46, 0, 68, 65, 83, 77, 32, 105, 115, 32, 102, 114, 101, 101, 32, 115, 111, 102, 116, 119, 97, 114, 101, 58, 32, 121, 111, 117, 32, 97, 114, 101, 32, 102, 114, 101, 101, 32, 116, 111, 32, 99, 104, 97, 110, 103, 101, 32, 97, 110, 100, 32, 114, 101, 100, 105, 115, 116, 114, 105, 98, 117, 116, 101, 32, 105, 116, 46, 0, 84, 104, 101, 114, 101, 32, 105, 115, 32, 65, 66, 83, 79, 76, 85, 84, 69, 76, 89, 32, 78, 79, 32, 87, 65, 82, 82, 65, 78, 84, 89, 44, 32, 116, 111, 32, 116, 104, 101, 32, 101, 120, 116, 101, 110, 116, 32, 112, 101, 114, 109, 105, 116, 116, 101, 100, 32, 98, 121, 32, 108, 97, 119, 46, 0, 85, 115, 97, 103, 101, 58, 32, 100, 97, 115, 109, 32, 115, 111, 117, 114, 99, 101, 102, 105, 108, 101, 32, 91, 111, 112, 116, 105, 111, 110, 115, 93, 0, 45, 102, 35, 32, 32, 32, 32, 32, 32, 111, 117, 116, 112, 117, 116, 32, 102, 111, 114, 109, 97, 116, 32, 49, 45, 51, 32, 40, 100, 101, 102, 97, 117, 108, 116, 32, 49, 41, 0, 45, 111, 110, 97, 109, 101, 32, 32, 32, 111, 117, 116, 112, 117, 116, 32, 102, 105, 108, 101, 32, 110, 97, 109, 101, 32, 40, 101, 108, 115, 101, 32, 97, 46, 111, 117, 116, 41, 0, 45, 108, 110, 97, 109, 101, 32, 32, 32, 108, 105, 115, 116, 32, 102, 105, 108, 101, 32, 110, 97, 109, 101, 32, 40, 101, 108, 115, 101, 32, 110, 111, 110, 101, 32, 103, 101, 110, 101, 114, 97, 116, 101, 100, 41, 0, 45, 76, 110, 97, 109, 101, 32, 32, 32, 108, 105, 115, 116, 32, 102, 105, 108, 101, 44, 32, 99, 111, 110, 116, 97, 105, 110, 105, 110, 103, 32, 97, 108, 108, 32, 112, 97, 115, 115, 101, 115, 0, 45, 115, 110, 97, 109, 101, 32, 32, 32, 115, 121, 109, 98, 111, 108, 32, 100, 117, 109, 112, 32, 102, 105, 108, 101, 32, 110, 97, 109, 101, 32, 40, 101, 108, 115, 101, 32, 110, 111, 110, 101, 32, 103, 101, 110, 101, 114, 97, 116, 101, 100, 41, 0, 45, 118, 35, 32, 32, 32, 32, 32, 32, 118, 101, 114, 98, 111, 115, 101, 110, 101, 115, 115, 32, 48, 45, 52, 32, 40, 100, 101, 102, 97, 117, 108, 116, 32, 48, 41, 0, 45, 100, 32, 32, 32, 32, 32, 32, 32, 100, 101, 98, 117, 103, 32, 109, 111, 100, 101, 32, 40, 102, 111, 114, 32, 100, 101, 118, 101, 108, 111, 112, 101, 114, 115, 41, 0, 45, 68, 115, 121, 109, 98, 111, 108, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 100, 101, 102, 105, 110, 101, 32, 115, 121, 109, 98, 111, 108, 44, 32, 115, 101, 116, 32, 116, 111, 32, 48, 0, 45, 68, 115, 121, 109, 98, 111, 108, 61, 101, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 32, 32, 100, 101, 102, 105, 110, 101, 32, 115, 121, 109, 98, 111, 108, 44, 32, 115, 101, 116, 32, 116, 111, 32, 101, 120, 112, 114, 101, 115, 115, 105, 111, 110, 0, 45, 77, 115, 121, 109, 98, 111, 108, 61, 101, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 32, 32, 100, 101, 102, 105, 110, 101, 32, 115, 121, 109, 98, 111, 108, 32, 117, 115, 105, 110, 103, 32, 69, 81, 77, 32, 40, 115, 97, 109, 101, 32, 97, 115, 32, 45, 68, 41, 0, 45, 73, 100, 105, 114, 32, 32, 32, 32, 115, 101, 97, 114, 99, 104, 32, 100, 105, 114, 101, 99, 116, 111, 114, 121, 32, 102, 111, 114, 32, 73, 78, 67, 76, 85, 68, 69, 32, 97, 110, 100, 32, 73, 78, 67, 66, 73, 78, 0, 45, 112, 35, 32, 32, 32, 32, 32, 32, 109, 97, 120, 105, 109, 117, 109, 32, 110, 117, 109, 98, 101, 114, 32, 111, 102, 32, 112, 97, 115, 115, 101, 115, 0, 45, 80, 35, 32, 32, 32, 32, 32, 32, 109, 97, 120, 105, 109, 117, 109, 32, 110, 117, 109, 98, 101, 114, 32, 111, 102, 32, 112, 97, 115, 115, 101, 115, 44, 32, 119, 105, 116, 104, 32, 102, 101, 119, 101, 114, 32, 99, 104, 101, 99, 107, 115, 0, 45, 84, 35, 32, 32, 32, 32, 32, 32, 115, 121, 109, 98, 111, 108, 32, 116, 97, 98, 108, 101, 32, 115, 111, 114, 116, 105, 110, 103, 32, 40, 100, 101, 102, 97, 117, 108, 116, 32, 48, 32, 61, 32, 97, 108, 112, 104, 97, 98, 101, 116, 105, 99, 97, 108, 44, 32, 49, 32, 61, 32, 97, 100, 100, 114, 101, 115, 115, 47, 118, 97, 108, 117, 101, 41, 0, 45, 69, 35, 32, 32, 32, 32, 32, 32, 101, 114, 114, 111, 114, 32, 102, 111, 114, 109, 97, 116, 32, 40, 100, 101, 102, 97, 117, 108, 116, 32, 48, 32, 61, 32, 77, 83, 44, 32, 49, 32, 61, 32, 68, 105, 108, 108, 111, 110, 44, 32, 50, 32, 61, 32, 71, 78, 85, 41, 0, 82, 101, 112, 111, 114, 116, 32, 98, 117, 103, 115, 32, 116, 111, 32, 100, 97, 115, 109, 45, 100, 105, 108, 108, 111, 110, 45, 100, 105, 115, 99, 117, 115, 115, 64, 108, 105, 115, 116, 115, 46, 115, 102, 46, 110, 101, 116, 32, 112, 108, 101, 97, 115, 101, 33, 0, 73, 110, 118, 97, 108, 105, 100, 32, 101, 114, 114, 111, 114, 32, 102, 111, 114, 109, 97, 116, 32, 102, 111, 114, 32, 45, 69, 44, 32, 109, 117, 115, 116, 32, 98, 101, 32, 48, 44, 32, 49, 44, 32, 50, 0, 73, 110, 118, 97, 108, 105, 100, 32, 115, 111, 114, 116, 105, 110, 103, 32, 109, 111, 100, 101, 32, 102, 111, 114, 32, 45, 84, 32, 111, 112, 116, 105, 111, 110, 44, 32, 109, 117, 115, 116, 32, 98, 101, 32, 48, 32, 111, 114, 32, 49, 0, 79, 78, 0, 68, 101, 98, 117, 103, 32, 116, 114, 97, 99, 101, 32, 37, 115, 10, 0, 48, 0, 73, 108, 108, 101, 103, 97, 108, 32, 102, 111, 114, 109, 97, 116, 32, 115, 112, 101, 99, 105, 102, 105, 99, 97, 116, 105, 111, 110, 0, 45, 111, 32, 83, 119, 105, 116, 99, 104, 32, 114, 101, 113, 117, 105, 114, 101, 115, 32, 102, 105, 108, 101, 32, 110, 97, 109, 101, 46, 0, 73, 78, 73, 84, 73, 65, 76, 32, 67, 79, 68, 69, 32, 83, 69, 71, 77, 69, 78, 84, 0, 83, 84, 65, 82, 84, 32, 79, 70, 32, 80, 65, 83, 83, 58, 32, 37, 100, 10, 0, 119, 98, 0, 87, 97, 114, 110, 105, 110, 103, 58, 32, 85, 110, 97, 98, 108, 101, 32, 116, 111, 32, 91, 114, 101, 93, 111, 112, 101, 110, 32, 39, 37, 115, 39, 10, 0, 45, 45, 45, 45, 45, 45, 45, 32, 70, 73, 76, 69, 32, 37, 115, 10, 0, 85, 110, 114, 101, 99, 111, 118, 101, 114, 97, 98, 108, 101, 32, 101, 114, 114, 111, 114, 40, 115, 41, 32, 105, 110, 32, 112, 97, 115, 115, 44, 32, 97, 98, 111, 114, 116, 105, 110, 103, 32, 97, 115, 115, 101, 109, 98, 108, 121, 33, 10, 0, 67, 111, 109, 112, 108, 101, 116, 101, 46, 10, 0, 45, 45, 45, 32, 85, 110, 114, 101, 115, 111, 108, 118, 101, 100, 32, 83, 121, 109, 98, 111, 108, 32, 76, 105, 115, 116, 10, 0, 45, 45, 45, 32, 37, 100, 32, 85, 110, 114, 101, 115, 111, 108, 118, 101, 100, 32, 83, 121, 109, 98, 111, 108, 37, 99, 10, 10, 0, 37, 45, 50, 52, 115, 32, 37, 45, 51, 115, 32, 37, 45, 56, 115, 32, 37, 45, 56, 115, 32, 37, 45, 56, 115, 32, 37, 45, 56, 115, 10, 0, 0, 10, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 0, 83, 69, 71, 77, 69, 78, 84, 32, 78, 65, 77, 69, 0, 73, 78, 73, 84, 32, 80, 67, 0, 73, 78, 73, 84, 32, 82, 80, 67, 0, 70, 73, 78, 65, 76, 32, 80, 67, 0, 70, 73, 78, 65, 76, 32, 82, 80, 67, 0, 91, 117, 93, 0, 32, 32, 32, 0, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 0, 37, 100, 32, 114, 101, 102, 101, 114, 101, 110, 99, 101, 115, 32, 116, 111, 32, 117, 110, 107, 110, 111, 119, 110, 32, 115, 121, 109, 98, 111, 108, 115, 46, 10, 0, 37, 100, 32, 101, 118, 101, 110, 116, 115, 32, 114, 101, 113, 117, 105, 114, 105, 110, 103, 32, 97, 110, 111, 116, 104, 101, 114, 32, 97, 115, 115, 101, 109, 98, 108, 101, 114, 32, 112, 97, 115, 115, 46, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 109, 110, 101, 109, 111, 110, 105, 99, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 79, 98, 115, 99, 117, 114, 101, 32, 114, 101, 97, 115, 111, 110, 32, 45, 32, 116, 111, 32, 98, 101, 32, 100, 111, 99, 117, 109, 101, 110, 116, 101, 100, 32, 58, 41, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 97, 32, 68, 67, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 97, 32, 68, 86, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 32, 40, 112, 114, 111, 98, 97, 98, 108, 121, 32, 105, 110, 32, 68, 86, 39, 115, 32, 69, 81, 77, 32, 115, 121, 109, 98, 111, 108, 41, 46, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 97, 32, 68, 86, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 32, 40, 99, 111, 117, 108, 100, 32, 98, 101, 32, 105, 110, 32, 68, 86, 39, 115, 32, 69, 81, 77, 32, 115, 121, 109, 98, 111, 108, 41, 46, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 97, 32, 68, 83, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 105, 110, 32, 97, 110, 32, 65, 76, 73, 71, 78, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 65, 76, 73, 71, 78, 58, 32, 82, 101, 108, 111, 99, 97, 116, 97, 98, 108, 101, 32, 111, 114, 105, 103, 105, 110, 32, 110, 111, 116, 32, 107, 110, 111, 119, 110, 32, 40, 105, 102, 32, 105, 110, 32, 82, 79, 82, 71, 32, 97, 116, 32, 116, 104, 101, 32, 116, 105, 109, 101, 41, 46, 10, 0, 32, 45, 32, 65, 76, 73, 71, 78, 58, 32, 78, 111, 114, 109, 97, 108, 32, 111, 114, 105, 103, 105, 110, 32, 110, 111, 116, 32, 107, 110, 111, 119, 110, 9, 40, 105, 102, 32, 105, 110, 32, 79, 82, 71, 32, 97, 116, 32, 116, 104, 101, 32, 116, 105, 109, 101, 41, 46, 10, 0, 32, 45, 32, 69, 81, 85, 58, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 69, 81, 85, 58, 32, 86, 97, 108, 117, 101, 32, 109, 105, 115, 109, 97, 116, 99, 104, 32, 102, 114, 111, 109, 32, 112, 114, 101, 118, 105, 111, 117, 115, 32, 112, 97, 115, 115, 32, 40, 112, 104, 97, 115, 101, 32, 101, 114, 114, 111, 114, 41, 46, 10, 0, 32, 45, 32, 73, 70, 58, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 82, 69, 80, 69, 65, 84, 58, 32, 69, 120, 112, 114, 101, 115, 115, 105, 111, 110, 32, 110, 111, 116, 32, 114, 101, 115, 111, 108, 118, 101, 100, 46, 10, 0, 32, 45, 32, 76, 97, 98, 101, 108, 32, 100, 101, 102, 105, 110, 101, 100, 32, 97, 102, 116, 101, 114, 32, 105, 116, 32, 104, 97, 115, 32, 98, 101, 101, 110, 32, 114, 101, 102, 101, 114, 101, 110, 99, 101, 100, 32, 40, 102, 111, 114, 119, 97, 114, 100, 32, 114, 101, 102, 101, 114, 101, 110, 99, 101, 41, 46, 10, 0, 32, 45, 32, 76, 97, 98, 101, 108, 32, 118, 97, 108, 117, 101, 32, 105, 115, 32, 100, 105, 102, 102, 101, 114, 101, 110, 116, 32, 102, 114, 111, 109, 32, 116, 104, 97, 116, 32, 111, 102, 32, 116, 104, 101, 32, 112, 114, 101, 118, 105, 111, 117, 115, 32, 112, 97, 115, 115, 32, 40, 112, 104, 97, 115, 101, 32, 101, 114, 114, 111, 114, 41, 46, 10, 0, 32, 45, 32, 66, 114, 97, 110, 99, 104, 32, 119, 97, 115, 32, 111, 117, 116, 32, 111, 102, 32, 114, 97, 110, 103, 101, 46, 10, 0, 255, 54, 53, 48, 50, 0, 54, 56, 48, 51, 0, 72, 68, 54, 51, 48, 51, 0, 104, 100, 54, 51, 48, 51, 0, 54, 56, 55, 48, 53, 0, 54, 56, 72, 67, 49, 49, 0, 54, 56, 104, 99, 49, 49, 0, 70, 56, 0, 102, 56, 0, 80, 67, 58, 32, 37, 48, 52, 108, 120, 32, 32, 77, 78, 69, 77, 79, 78, 73, 67, 58, 32, 37, 115, 32, 32, 97, 100, 100, 114, 109, 111, 100, 101, 58, 32, 37, 100, 32, 32, 0, 109, 110, 101, 109, 97, 115, 107, 58, 32, 37, 48, 56, 108, 120, 32, 97, 100, 114, 109, 111, 100, 101, 58, 32, 37, 100, 32, 32, 67, 118, 116, 91, 97, 109, 93, 58, 32, 37, 100, 10, 0, 102, 105, 110, 97, 108, 32, 97, 100, 100, 114, 109, 111, 100, 101, 32, 61, 32, 37, 100, 10, 0, 85, 110, 104, 97, 110, 100, 108, 101, 100, 32, 105, 110, 116, 101, 114, 110, 97, 108, 32, 102, 111, 114, 109, 97, 116, 32, 115, 112, 101, 99, 105, 102, 105, 101, 114, 0, 115, 101, 103, 109, 101, 110, 116, 58, 32, 37, 115, 32, 37, 115, 32, 32, 118, 115, 32, 99, 117, 114, 114, 101, 110, 116, 32, 111, 114, 103, 58, 32, 37, 48, 52, 108, 120, 10, 0, 108, 111, 99, 97, 108, 111, 102, 102, 0, 76, 79, 67, 65, 76, 79, 70, 70, 0, 108, 111, 99, 97, 108, 111, 110, 0, 76, 79, 67, 65, 76, 79, 78, 0, 111, 102, 102, 0, 79, 70, 70, 0, 114, 98, 0, 117, 110, 97, 98, 108, 101, 32, 116, 111, 32, 111, 112, 101, 110, 32, 37, 115, 10, 0, 66, 97, 100, 32, 72, 101, 120, 32, 68, 105, 103, 105, 116, 32, 37, 99, 0, 40, 77, 117, 115, 116, 32, 98, 101, 32, 97, 32, 118, 97, 108, 105, 100, 32, 104, 101, 120, 32, 100, 105, 103, 105, 116, 41, 0, 40, 77, 117, 115, 116, 32, 98, 101, 32, 97, 32, 118, 97, 108, 105, 100, 32, 104, 101, 120, 32, 100, 105, 103, 105, 116, 41, 10, 0, 120, 46, 120, 0, 69, 81, 77, 32, 108, 97, 98, 101, 108, 32, 110, 111, 116, 32, 102, 111, 117, 110, 100, 0, 109, 117, 115, 116, 32, 115, 112, 101, 99, 105, 102, 121, 32, 69, 81, 77, 32, 108, 97, 98, 101, 108, 32, 102, 111, 114, 32, 68, 86, 0, 111, 108, 100, 32, 118, 97, 108, 117 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 51440);
  allocate([ 101, 58, 32, 36, 37, 48, 52, 108, 120, 32, 32, 110, 101, 119, 32, 118, 97, 108, 117, 101, 58, 32, 36, 37, 48, 52, 108, 120, 10, 0, 36, 37, 108, 120, 0, 32, 37, 115, 0, 10, 0, 105, 110, 102, 105, 110, 105, 116, 101, 32, 109, 97, 99, 114, 111, 32, 114, 101, 99, 117, 114, 115, 105, 111, 110, 0, 110, 111, 116, 32, 119, 105, 116, 104, 105, 110, 32, 97, 32, 109, 97, 99, 114, 111, 0, 116, 111, 111, 32, 109, 97, 110, 121, 32, 101, 110, 100, 105, 102, 39, 115, 0, 110, 111, 32, 114, 101, 112, 101, 97, 116, 0, 1, 1, 97, 46, 111, 117, 116, 0, 108, 105, 115, 116, 0, 105, 110, 99, 108, 117, 100, 101, 0, 115, 101, 103, 0, 104, 101, 120, 0, 101, 114, 114, 0, 98, 121, 116, 101, 0, 119, 111, 114, 100, 0, 108, 111, 110, 103, 0, 100, 118, 0, 101, 110, 100, 0, 116, 114, 97, 99, 101, 0, 111, 114, 103, 0, 114, 111, 114, 103, 0, 114, 101, 110, 100, 0, 97, 108, 105, 103, 110, 0, 115, 117, 98, 114, 111, 117, 116, 105, 110, 101, 0, 101, 113, 117, 0, 61, 0, 101, 113, 109, 0, 115, 101, 116, 0, 109, 97, 99, 0, 101, 110, 100, 109, 0, 109, 101, 120, 105, 116, 0, 105, 102, 99, 111, 110, 115, 116, 0, 105, 102, 110, 99, 111, 110, 115, 116, 0, 105, 102, 0, 101, 108, 115, 101, 0, 101, 110, 100, 105, 102, 0, 101, 105, 102, 0, 114, 101, 112, 101, 97, 116, 0, 114, 101, 112, 101, 110, 100, 0, 101, 99, 104, 111, 0, 112, 114, 111, 99, 101, 115, 115, 111, 114, 0, 105, 110, 99, 98, 105, 110, 0, 105, 110, 99, 100, 105, 114, 0, 99, 104, 97, 114, 32, 39, 37, 99, 39, 10, 0, 116, 111, 111, 32, 109, 97, 110, 121, 32, 111, 112, 115, 0, 37, 115, 0, 39, 93, 39, 32, 101, 114, 114, 111, 114, 44, 32, 110, 111, 32, 97, 114, 103, 32, 111, 110, 32, 115, 116, 97, 99, 107, 0, 37, 108, 100, 0, 83, 84, 82, 73, 78, 71, 58, 32, 37, 115, 10, 0, 115, 116, 97, 99, 107, 97, 114, 103, 32, 37, 108, 100, 32, 40, 64, 37, 100, 41, 10, 0, 115, 116, 97, 99, 107, 97, 114, 103, 58, 32, 109, 97, 120, 97, 114, 103, 115, 32, 115, 116, 97, 99, 107, 101, 100, 0, 101, 118, 97, 108, 116, 111, 112, 32, 64, 40, 65, 44, 79, 41, 32, 37, 100, 32, 37, 100, 10, 0, 99, 104, 97, 114, 32, 61, 32, 39, 37, 99, 39, 32, 37, 100, 32, 40, 45, 49, 58, 32, 37, 100, 41, 10, 0, 99, 104, 97, 114, 32, 61, 32, 39, 37, 99, 39, 32, 99, 111, 100, 101, 32, 37, 100, 10, 0, 100, 111, 111, 112, 0, 100, 111, 111, 112, 32, 64, 32, 37, 100, 32, 117, 110, 97, 114, 121, 10, 0, 100, 111, 111, 112, 32, 64, 32, 37, 100, 10, 0, 100, 111, 111, 112, 58, 32, 116, 111, 111, 32, 109, 97, 110, 121, 32, 111, 112, 101, 114, 97, 116, 111, 114, 115, 0, 37, 108, 100, 37, 46, 42, 115, 0, 37, 108, 100, 36, 37, 46, 42, 115, 0, 114, 101, 100, 111, 32, 49, 51, 58, 32, 39, 37, 115, 39, 32, 37, 48, 52, 120, 32, 37, 48, 52, 120, 10, 0, 37, 115, 32, 37, 115, 0, 115, 108, 112, 0, 97, 105, 109, 0, 111, 105, 109, 0, 101, 105, 109, 0, 116, 105, 109, 0, 97, 110, 99, 0, 97, 110, 101, 0, 97, 114, 114, 0, 98, 114, 107, 0, 99, 108, 100, 0, 100, 99, 112, 0, 105, 115, 98, 0, 108, 97, 115, 0, 108, 97, 120, 0, 108, 120, 97, 0, 112, 104, 97, 0, 112, 104, 112, 0, 112, 108, 97, 0, 112, 108, 112, 0, 114, 108, 97, 0, 114, 114, 97, 0, 115, 97, 120, 0, 115, 98, 120, 0, 115, 101, 100, 0, 115, 104, 97, 0, 115, 104, 115, 0, 115, 104, 120, 0, 115, 104, 121, 0, 115, 108, 111, 0, 115, 114, 101, 0, 116, 97, 121, 0, 116, 121, 97, 0, 97, 100, 100, 0, 97, 110, 100, 0, 97, 115, 108, 120, 0, 97, 115, 114, 120, 0, 98, 104, 99, 99, 0, 98, 104, 99, 115, 0, 98, 105, 104, 0, 98, 105, 108, 0, 98, 105, 116, 0, 98, 109, 99, 0, 98, 109, 115, 0, 99, 108, 114, 120, 0, 99, 109, 112, 0, 99, 111, 109, 120, 0, 100, 101, 99, 120, 0, 101, 111, 114, 0, 105, 110, 99, 120, 0, 108, 100, 97, 0, 108, 115, 108, 120, 0, 108, 115, 114, 120, 0, 110, 101, 103, 120, 0, 111, 114, 97, 0, 114, 111, 108, 120, 0, 114, 111, 114, 120, 0, 114, 115, 112, 0, 115, 98, 99, 0, 115, 116, 97, 0, 115, 117, 98, 0, 116, 97, 120, 0, 116, 115, 116, 120, 0, 116, 120, 97, 0, 97, 98, 97, 0, 97, 98, 120, 0, 97, 98, 121, 0, 97, 100, 99, 97, 0, 97, 100, 99, 98, 0, 97, 100, 100, 97, 0, 97, 100, 100, 98, 0, 97, 100, 100, 100, 0, 97, 110, 100, 97, 0, 97, 110, 100, 98, 0, 97, 115, 108, 97, 0, 97, 115, 108, 98, 0, 97, 115, 108, 0, 97, 115, 108, 100, 0, 97, 115, 114, 97, 0, 97, 115, 114, 98, 0, 97, 115, 114, 0, 98, 99, 99, 0, 98, 99, 108, 114, 0, 98, 99, 115, 0, 98, 101, 113, 0, 98, 103, 101, 0, 98, 103, 116, 0, 98, 104, 105, 0, 98, 104, 115, 0, 98, 105, 116, 97, 0, 98, 105, 116, 98, 0, 98, 108, 101, 0, 98, 108, 111, 0, 98, 108, 115, 0, 98, 108, 116, 0, 98, 109, 105, 0, 98, 110, 101, 0, 98, 112, 108, 0, 98, 114, 97, 0, 98, 114, 99, 108, 114, 0, 98, 114, 110, 0, 98, 114, 115, 101, 116, 0, 98, 115, 101, 116, 0, 98, 115, 114, 0, 98, 118, 99, 0, 98, 118, 115, 0, 99, 98, 97, 0, 99, 108, 99, 0, 99, 108, 105, 0, 99, 108, 114, 97, 0, 99, 108, 114, 98, 0, 99, 108, 118, 0, 99, 109, 112, 97, 0, 99, 109, 112, 98, 0, 99, 111, 109, 97, 0, 99, 111, 109, 98, 0, 99, 112, 100, 0, 99, 112, 120, 0, 99, 112, 121, 0, 100, 97, 97, 0, 100, 101, 99, 97, 0, 100, 101, 99, 98, 0, 100, 101, 99, 0, 100, 101, 115, 0, 100, 101, 120, 0, 100, 101, 121, 0, 101, 111, 114, 97, 0, 101, 111, 114, 98, 0, 102, 100, 105, 118, 0, 105, 100, 105, 118, 0, 105, 110, 99, 97, 0, 105, 110, 99, 98, 0, 105, 110, 120, 0, 105, 110, 121, 0, 106, 115, 114, 0, 108, 100, 97, 97, 0, 108, 100, 97, 98, 0, 108, 100, 100, 0, 108, 100, 115, 0, 108, 100, 120, 0, 108, 100, 121, 0, 108, 115, 108, 97, 0, 108, 115, 108, 98, 0, 108, 115, 108, 0, 108, 115, 108, 100, 0, 108, 115, 114, 97, 0, 108, 115, 114, 98, 0, 108, 115, 114, 0, 108, 115, 114, 100, 0, 109, 117, 108, 0, 110, 101, 103, 97, 0, 110, 101, 103, 98, 0, 110, 101, 103, 0, 111, 114, 97, 97, 0, 111, 114, 97, 98, 0, 112, 115, 104, 97, 0, 112, 115, 104, 98, 0, 112, 115, 104, 120, 0, 112, 115, 104, 121, 0, 112, 117, 108, 97, 0, 112, 117, 108, 98, 0, 112, 117, 108, 120, 0, 112, 117, 108, 121, 0, 114, 111, 108, 97, 0, 114, 111, 108, 98, 0, 114, 111, 108, 0, 114, 111, 114, 97, 0, 114, 111, 114, 98, 0, 114, 111, 114, 0, 114, 116, 105, 0, 114, 116, 115, 0, 115, 98, 97, 0, 115, 98, 99, 97, 0, 115, 98, 99, 98, 0, 115, 101, 99, 0, 115, 101, 105, 0, 115, 101, 118, 0, 115, 116, 97, 97, 0, 115, 116, 97, 98, 0, 115, 116, 100, 0, 115, 116, 111, 112, 0, 115, 116, 115, 0, 115, 116, 120, 0, 115, 116, 121, 0, 115, 117, 98, 97, 0, 115, 117, 98, 98, 0, 115, 117, 98, 100, 0, 115, 119, 105, 0, 116, 97, 98, 0, 116, 97, 112, 0, 116, 98, 97, 0, 116, 101, 115, 116, 0, 116, 112, 97, 0, 116, 115, 116, 97, 0, 116, 115, 116, 98, 0, 116, 115, 116, 0, 116, 115, 120, 0, 116, 115, 121, 0, 116, 120, 115, 0, 116, 121, 115, 0, 119, 97, 105, 0, 120, 103, 100, 120, 0, 120, 103, 100, 121, 0, 114, 101, 115, 0, 100, 98, 0, 100, 119, 0, 100, 100, 0, 97, 100, 99, 0, 97, 105, 0, 97, 109, 0, 97, 109, 100, 0, 97, 115, 0, 97, 115, 100, 0, 98, 99, 0, 98, 102, 0, 98, 109, 0, 98, 110, 99, 0, 98, 110, 111, 0, 98, 110, 122, 0, 98, 112, 0, 98, 114, 0, 98, 114, 55, 0, 98, 116, 0, 98, 122, 0, 99, 105, 0, 99, 108, 114, 0, 99, 109, 0, 99, 111, 109, 0, 100, 99, 105, 0, 100, 105, 0, 100, 115, 0, 101, 105, 0, 105, 110, 0, 105, 110, 99, 0, 105, 110, 115, 0, 106, 109, 112, 0, 108, 105, 0, 108, 105, 115, 0, 108, 105, 115, 108, 0, 108, 105, 115, 117, 0, 108, 109, 0, 108, 110, 107, 0, 108, 114, 0, 110, 105, 0, 110, 109, 0, 110, 111, 112, 0, 110, 115, 0, 111, 105, 0, 111, 109, 0, 111, 117, 116, 0, 111, 117, 116, 115, 0, 112, 105, 0, 112, 107, 0, 112, 111, 112, 0, 115, 108, 0, 115, 114, 0, 115, 116, 0, 120, 100, 99, 0, 120, 105, 0, 120, 109, 0, 120, 115, 0, 32, 0, 115, 0, 40, 105, 115, 41, 0, 105, 0, 40, 105, 115, 41, 43, 0, 100, 0, 40, 105, 115, 41, 45, 0, 106, 0, 104, 117, 0, 104, 108, 0, 97, 0, 100, 99, 48, 0, 100, 99, 0, 104, 0, 105, 115, 0, 107, 0, 107, 117, 0, 107, 108, 0, 112, 99, 48, 0, 112, 48, 0, 112, 99, 49, 0, 112, 0, 113, 0, 113, 117, 0, 113, 108, 0, 119, 0, 37, 100, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 255, 255, 255, 255, 255, 255, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 255, 255, 255, 255, 255, 255, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 1, 2, 4, 7, 3, 6, 5, 0, 17, 0, 10, 0, 17, 17, 17, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 15, 10, 17, 17, 17, 3, 10, 7, 0, 1, 19, 9, 11, 11, 0, 0, 9, 6, 11, 0, 0, 11, 0, 6, 17, 0, 0, 0, 17, 17, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 10, 10, 17, 17, 17, 0, 10, 0, 0, 2, 0, 9, 11, 0, 0, 0, 9, 0, 11, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 0, 0, 9, 12, 0, 0, 0, 0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, 0, 4, 13, 0, 0, 0, 0, 9, 14, 0, 0, 0, 0, 0, 14, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 15, 0, 0, 0, 0, 9, 16, 0, 0, 0, 0, 0, 16, 0, 0, 16, 0, 0, 18, 0, 0, 0, 18, 18, 18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 18, 0, 0, 0, 18, 18, 18, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 9, 11, 0, 0, 0, 0, 0, 11, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 0, 0, 9, 12, 0, 0, 0, 0, 0, 12, 0, 0, 12, 0, 0, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 65, 66, 67, 68, 69, 70, 45, 43, 32, 32, 32, 48, 88, 48, 120, 0, 40, 110, 117, 108, 108, 41, 0, 45, 48, 88, 43, 48, 88, 32, 48, 88, 45, 48, 120, 43, 48, 120, 32, 48, 120, 0, 105, 110, 102, 0, 73, 78, 70, 0, 110, 97, 110, 0, 78, 65, 78, 0, 46, 0, 84, 33, 34, 25, 13, 1, 2, 3, 17, 75, 28, 12, 16, 4, 11, 29, 18, 30, 39, 104, 110, 111, 112, 113, 98, 32, 5, 6, 15, 19, 20, 21, 26, 8, 22, 7, 40, 36, 23, 24, 9, 10, 14, 27, 31, 37, 35, 131, 130, 125, 38, 42, 43, 60, 61, 62, 63, 67, 71, 74, 77, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 99, 100, 101, 102, 103, 105, 106, 107, 108, 114, 115, 116, 121, 122, 123, 124, 0, 73, 108, 108, 101, 103, 97, 108, 32, 98, 121, 116, 101, 32, 115, 101, 113, 117, 101, 110, 99, 101, 0, 68, 111, 109, 97, 105, 110, 32, 101, 114, 114, 111, 114, 0, 82, 101, 115, 117, 108, 116, 32, 110, 111, 116, 32, 114, 101, 112, 114, 101, 115, 101, 110, 116, 97, 98, 108, 101, 0, 78, 111, 116, 32, 97, 32, 116, 116, 121, 0, 80, 101, 114, 109, 105, 115, 115, 105, 111, 110, 32, 100, 101, 110, 105, 101, 100, 0, 79, 112, 101, 114, 97, 116, 105, 111, 110, 32, 110, 111, 116, 32, 112, 101, 114, 109, 105, 116, 116, 101, 100, 0, 78, 111, 32, 115, 117, 99, 104, 32, 102, 105, 108, 101, 32, 111, 114, 32, 100, 105, 114, 101, 99, 116, 111, 114, 121, 0, 78, 111, 32, 115, 117, 99, 104, 32, 112, 114, 111, 99, 101, 115, 115, 0, 70, 105, 108, 101, 32, 101, 120, 105, 115, 116, 115, 0, 86, 97, 108, 117, 101, 32, 116, 111, 111, 32, 108, 97, 114, 103, 101, 32, 102, 111, 114, 32, 100, 97, 116, 97, 32, 116, 121, 112, 101, 0, 78, 111, 32, 115, 112, 97, 99, 101, 32, 108, 101, 102, 116, 32, 111, 110, 32, 100, 101, 118, 105, 99, 101, 0, 79, 117, 116, 32, 111, 102, 32, 109, 101, 109, 111, 114, 121, 0, 82, 101, 115, 111, 117, 114, 99, 101, 32, 98, 117, 115, 121, 0, 73, 110, 116, 101, 114, 114, 117, 112, 116, 101, 100, 32, 115, 121, 115, 116, 101, 109, 32, 99, 97, 108, 108, 0, 82, 101, 115, 111, 117, 114, 99, 101, 32, 116, 101, 109, 112, 111, 114, 97, 114, 105, 108, 121, 32, 117, 110, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 73, 110, 118, 97, 108, 105, 100, 32, 115, 101, 101, 107, 0, 67, 114, 111, 115, 115, 45, 100, 101, 118, 105, 99, 101, 32, 108, 105, 110, 107, 0, 82, 101, 97, 100, 45, 111, 110, 108, 121, 32, 102, 105, 108, 101, 32, 115, 121, 115, 116, 101, 109, 0, 68, 105, 114, 101, 99, 116, 111, 114, 121, 32, 110, 111, 116, 32, 101, 109, 112, 116, 121, 0, 67, 111, 110, 110, 101, 99, 116, 105, 111, 110, 32, 114, 101, 115, 101, 116, 32, 98, 121, 32, 112, 101, 101, 114, 0, 79, 112, 101, 114, 97, 116, 105, 111, 110, 32, 116, 105, 109, 101, 100, 32, 111, 117, 116, 0, 67, 111, 110, 110, 101, 99, 116, 105, 111, 110, 32, 114, 101, 102, 117, 115, 101, 100, 0, 72, 111, 115, 116, 32, 105, 115, 32, 100, 111, 119, 110, 0, 72, 111, 115, 116, 32, 105, 115, 32, 117, 110, 114, 101, 97, 99, 104, 97, 98, 108, 101, 0, 65, 100, 100, 114, 101, 115, 115, 32, 105, 110, 32, 117, 115, 101, 0, 66, 114, 111, 107, 101, 110, 32, 112, 105, 112, 101, 0, 73, 47, 79, 32, 101, 114, 114, 111, 114, 0, 78, 111, 32, 115, 117, 99, 104, 32, 100, 101, 118, 105, 99, 101, 32, 111, 114, 32, 97, 100, 100, 114, 101, 115, 115, 0, 66, 108, 111, 99, 107, 32, 100, 101, 118, 105, 99, 101, 32, 114, 101, 113, 117, 105, 114, 101, 100, 0, 78, 111, 32, 115, 117, 99, 104, 32, 100, 101, 118, 105, 99, 101, 0, 78, 111, 116, 32, 97, 32, 100, 105, 114, 101, 99, 116, 111, 114, 121, 0, 73, 115, 32, 97, 32, 100, 105, 114, 101, 99, 116, 111, 114, 121, 0, 84, 101, 120, 116, 32, 102, 105, 108, 101, 32, 98, 117, 115, 121, 0, 69, 120, 101, 99, 32, 102, 111, 114, 109, 97, 116, 32, 101, 114, 114, 111, 114, 0, 73, 110, 118, 97, 108, 105, 100, 32, 97, 114, 103, 117, 109, 101, 110, 116, 0, 65, 114, 103, 117, 109, 101, 110, 116, 32, 108, 105, 115, 116, 32, 116, 111, 111, 32, 108, 111, 110, 103, 0, 83, 121, 109, 98, 111, 108, 105, 99, 32, 108, 105, 110, 107, 32, 108, 111, 111, 112, 0, 70, 105, 108, 101, 110, 97, 109, 101, 32, 116, 111, 111, 32, 108, 111, 110, 103, 0, 84, 111, 111, 32, 109, 97, 110, 121, 32, 111, 112, 101, 110, 32, 102, 105, 108, 101, 115, 32, 105, 110, 32, 115, 121, 115, 116, 101, 109, 0, 78, 111, 32, 102, 105, 108, 101, 32, 100, 101, 115, 99, 114, 105, 112, 116, 111, 114, 115, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 66, 97, 100, 32, 102, 105, 108, 101, 32, 100, 101, 115, 99, 114, 105, 112, 116, 111, 114, 0, 78, 111, 32, 99, 104, 105, 108, 100, 32, 112, 114, 111, 99, 101, 115, 115, 0, 66, 97, 100, 32, 97, 100, 100, 114, 101, 115, 115, 0, 70, 105, 108, 101, 32, 116, 111, 111, 32, 108, 97, 114, 103, 101, 0, 84, 111, 111, 32, 109, 97, 110, 121, 32, 108, 105, 110, 107, 115, 0, 78, 111, 32, 108, 111, 99, 107, 115, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 82, 101, 115, 111, 117, 114, 99, 101, 32, 100, 101, 97, 100, 108, 111, 99, 107, 32, 119, 111, 117, 108, 100, 32, 111, 99, 99, 117, 114, 0, 83, 116, 97, 116, 101, 32, 110, 111, 116, 32, 114, 101, 99, 111, 118, 101, 114, 97, 98, 108, 101, 0, 80, 114, 101, 118, 105, 111, 117, 115, 32, 111, 119, 110, 101, 114, 32, 100, 105, 101, 100, 0, 79, 112, 101, 114, 97, 116, 105, 111, 110, 32, 99, 97, 110, 99, 101, 108, 101, 100, 0, 70, 117, 110, 99, 116, 105, 111, 110, 32, 110, 111, 116, 32, 105, 109, 112, 108, 101, 109, 101, 110, 116, 101, 100, 0, 78, 111, 32, 109, 101, 115, 115, 97, 103, 101, 32, 111, 102, 32, 100, 101, 115, 105, 114, 101, 100, 32, 116, 121, 112, 101, 0, 73, 100, 101, 110, 116, 105, 102, 105, 101, 114, 32, 114, 101, 109, 111, 118, 101, 100, 0, 68, 101, 118, 105, 99, 101, 32, 110, 111, 116, 32, 97, 32, 115, 116, 114, 101, 97, 109, 0, 78, 111, 32, 100, 97, 116, 97, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 68, 101, 118, 105, 99, 101, 32, 116, 105, 109, 101, 111, 117, 116, 0, 79, 117, 116, 32, 111, 102, 32, 115, 116, 114, 101, 97, 109, 115, 32, 114, 101, 115, 111, 117, 114, 99, 101, 115, 0, 76, 105, 110, 107, 32, 104, 97, 115, 32, 98, 101, 101, 110, 32, 115, 101, 118, 101, 114, 101, 100, 0, 80, 114, 111, 116, 111, 99, 111, 108, 32, 101, 114, 114, 111, 114, 0, 66, 97, 100, 32, 109, 101, 115, 115, 97, 103, 101, 0, 70, 105, 108, 101, 32, 100, 101, 115, 99, 114, 105, 112, 116, 111, 114, 32, 105, 110, 32, 98, 97, 100, 32, 115, 116, 97, 116, 101, 0, 78, 111, 116, 32, 97, 32, 115, 111, 99, 107, 101, 116, 0, 68, 101, 115, 116, 105, 110, 97, 116, 105, 111, 110, 32, 97, 100, 100, 114, 101, 115, 115, 32, 114, 101, 113, 117, 105, 114, 101, 100, 0, 77, 101, 115, 115, 97, 103, 101, 32, 116, 111, 111, 32, 108, 97, 114, 103, 101, 0, 80, 114, 111, 116, 111, 99, 111, 108, 32, 119, 114, 111, 110, 103, 32, 116, 121, 112, 101, 32, 102, 111, 114, 32, 115, 111, 99, 107, 101, 116, 0, 80, 114, 111, 116, 111, 99, 111, 108, 32, 110, 111, 116, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 80, 114, 111, 116, 111, 99, 111, 108, 32, 110, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 0, 83, 111, 99, 107, 101, 116, 32, 116, 121, 112, 101, 32, 110, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 0, 78, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 0, 80, 114, 111, 116, 111, 99, 111, 108, 32, 102, 97, 109, 105, 108, 121, 32, 110, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 0, 65, 100, 100, 114, 101, 115, 115, 32, 102, 97, 109, 105, 108, 121, 32, 110, 111, 116, 32, 115, 117, 112, 112, 111, 114, 116, 101, 100, 32, 98, 121, 32, 112, 114, 111, 116, 111, 99, 111, 108, 0, 65, 100, 100, 114, 101, 115, 115, 32, 110, 111, 116, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 78, 101, 116, 119, 111, 114, 107, 32, 105, 115, 32, 100, 111, 119, 110, 0, 78, 101, 116, 119, 111, 114, 107, 32, 117, 110, 114, 101, 97, 99, 104, 97, 98, 108, 101, 0, 67, 111, 110, 110, 101, 99, 116, 105, 111, 110, 32, 114, 101, 115, 101, 116, 32, 98, 121, 32, 110, 101, 116, 119, 111, 114, 107, 0, 67, 111, 110, 110, 101, 99, 116, 105, 111, 110, 32, 97, 98, 111, 114, 116, 101, 100, 0, 78, 111, 32, 98, 117, 102, 102, 101, 114, 32, 115, 112, 97, 99, 101, 32, 97, 118, 97, 105, 108, 97, 98, 108, 101, 0, 83, 111, 99, 107, 101, 116, 32, 105, 115, 32, 99, 111, 110, 110, 101, 99, 116, 101, 100, 0, 83, 111, 99, 107, 101, 116, 32, 110, 111, 116, 32, 99, 111, 110, 110, 101, 99, 116, 101, 100, 0, 67, 97, 110, 110, 111, 116, 32, 115, 101, 110, 100, 32, 97, 102, 116, 101, 114, 32, 115, 111, 99, 107, 101, 116, 32, 115, 104, 117, 116, 100, 111, 119, 110, 0, 79, 112, 101, 114, 97, 116, 105, 111, 110, 32, 97, 108, 114, 101, 97, 100, 121, 32, 105, 110, 32, 112, 114, 111, 103, 114, 101, 115, 115, 0, 79, 112, 101, 114, 97, 116, 105, 111, 110, 32, 105, 110, 32, 112, 114, 111, 103, 114, 101, 115, 115, 0, 83, 116, 97, 108, 101, 32, 102, 105, 108, 101, 32, 104, 97, 110, 100, 108, 101, 0, 82, 101, 109, 111, 116, 101, 32, 73, 47, 79, 32, 101, 114, 114, 111, 114, 0, 81, 117, 111, 116, 97, 32, 101, 120, 99, 101, 101, 100, 101, 100, 0, 78, 111, 32, 109, 101, 100, 105, 117, 109, 32, 102, 111, 117, 110, 100, 0, 87, 114, 111, 110, 103, 32, 109, 101, 100, 105, 117, 109, 32, 116, 121, 112, 101, 0, 78, 111, 32, 101, 114, 114, 111, 114, 32, 105, 110, 102, 111, 114, 109, 97, 116, 105, 111, 110, 0, 0, 114, 119, 97, 0 ], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE + 61680);
  var tempDoublePtr = STATICTOP;
  STATICTOP += 16;
  Module["_i64Subtract"] = _i64Subtract;
  Module["_i64Add"] = _i64Add;
  Module["_memset"] = _memset;
  function _pthread_cleanup_push(routine, arg) {
   __ATEXIT__.push((function() {
    Runtime.dynCall("vi", routine, [ arg ]);
   }));
   _pthread_cleanup_push.level = __ATEXIT__.length;
  }
  Module["_bitshift64Lshr"] = _bitshift64Lshr;
  Module["_bitshift64Shl"] = _bitshift64Shl;
  function _pthread_cleanup_pop() {
   assert(_pthread_cleanup_push.level == __ATEXIT__.length, "cannot pop if something else added meanwhile!");
   __ATEXIT__.pop();
   _pthread_cleanup_push.level = __ATEXIT__.length;
  }
  function _abort() {
   Module["abort"]();
  }
  var ERRNO_CODES = {
   EPERM: 1,
   ENOENT: 2,
   ESRCH: 3,
   EINTR: 4,
   EIO: 5,
   ENXIO: 6,
   E2BIG: 7,
   ENOEXEC: 8,
   EBADF: 9,
   ECHILD: 10,
   EAGAIN: 11,
   EWOULDBLOCK: 11,
   ENOMEM: 12,
   EACCES: 13,
   EFAULT: 14,
   ENOTBLK: 15,
   EBUSY: 16,
   EEXIST: 17,
   EXDEV: 18,
   ENODEV: 19,
   ENOTDIR: 20,
   EISDIR: 21,
   EINVAL: 22,
   ENFILE: 23,
   EMFILE: 24,
   ENOTTY: 25,
   ETXTBSY: 26,
   EFBIG: 27,
   ENOSPC: 28,
   ESPIPE: 29,
   EROFS: 30,
   EMLINK: 31,
   EPIPE: 32,
   EDOM: 33,
   ERANGE: 34,
   ENOMSG: 42,
   EIDRM: 43,
   ECHRNG: 44,
   EL2NSYNC: 45,
   EL3HLT: 46,
   EL3RST: 47,
   ELNRNG: 48,
   EUNATCH: 49,
   ENOCSI: 50,
   EL2HLT: 51,
   EDEADLK: 35,
   ENOLCK: 37,
   EBADE: 52,
   EBADR: 53,
   EXFULL: 54,
   ENOANO: 55,
   EBADRQC: 56,
   EBADSLT: 57,
   EDEADLOCK: 35,
   EBFONT: 59,
   ENOSTR: 60,
   ENODATA: 61,
   ETIME: 62,
   ENOSR: 63,
   ENONET: 64,
   ENOPKG: 65,
   EREMOTE: 66,
   ENOLINK: 67,
   EADV: 68,
   ESRMNT: 69,
   ECOMM: 70,
   EPROTO: 71,
   EMULTIHOP: 72,
   EDOTDOT: 73,
   EBADMSG: 74,
   ENOTUNIQ: 76,
   EBADFD: 77,
   EREMCHG: 78,
   ELIBACC: 79,
   ELIBBAD: 80,
   ELIBSCN: 81,
   ELIBMAX: 82,
   ELIBEXEC: 83,
   ENOSYS: 38,
   ENOTEMPTY: 39,
   ENAMETOOLONG: 36,
   ELOOP: 40,
   EOPNOTSUPP: 95,
   EPFNOSUPPORT: 96,
   ECONNRESET: 104,
   ENOBUFS: 105,
   EAFNOSUPPORT: 97,
   EPROTOTYPE: 91,
   ENOTSOCK: 88,
   ENOPROTOOPT: 92,
   ESHUTDOWN: 108,
   ECONNREFUSED: 111,
   EADDRINUSE: 98,
   ECONNABORTED: 103,
   ENETUNREACH: 101,
   ENETDOWN: 100,
   ETIMEDOUT: 110,
   EHOSTDOWN: 112,
   EHOSTUNREACH: 113,
   EINPROGRESS: 115,
   EALREADY: 114,
   EDESTADDRREQ: 89,
   EMSGSIZE: 90,
   EPROTONOSUPPORT: 93,
   ESOCKTNOSUPPORT: 94,
   EADDRNOTAVAIL: 99,
   ENETRESET: 102,
   EISCONN: 106,
   ENOTCONN: 107,
   ETOOMANYREFS: 109,
   EUSERS: 87,
   EDQUOT: 122,
   ESTALE: 116,
   ENOTSUP: 95,
   ENOMEDIUM: 123,
   EILSEQ: 84,
   EOVERFLOW: 75,
   ECANCELED: 125,
   ENOTRECOVERABLE: 131,
   EOWNERDEAD: 130,
   ESTRPIPE: 86
  };
  var ERRNO_MESSAGES = {
   0: "Success",
   1: "Not super-user",
   2: "No such file or directory",
   3: "No such process",
   4: "Interrupted system call",
   5: "I/O error",
   6: "No such device or address",
   7: "Arg list too long",
   8: "Exec format error",
   9: "Bad file number",
   10: "No children",
   11: "No more processes",
   12: "Not enough core",
   13: "Permission denied",
   14: "Bad address",
   15: "Block device required",
   16: "Mount device busy",
   17: "File exists",
   18: "Cross-device link",
   19: "No such device",
   20: "Not a directory",
   21: "Is a directory",
   22: "Invalid argument",
   23: "Too many open files in system",
   24: "Too many open files",
   25: "Not a typewriter",
   26: "Text file busy",
   27: "File too large",
   28: "No space left on device",
   29: "Illegal seek",
   30: "Read only file system",
   31: "Too many links",
   32: "Broken pipe",
   33: "Math arg out of domain of func",
   34: "Math result not representable",
   35: "File locking deadlock error",
   36: "File or path name too long",
   37: "No record locks available",
   38: "Function not implemented",
   39: "Directory not empty",
   40: "Too many symbolic links",
   42: "No message of desired type",
   43: "Identifier removed",
   44: "Channel number out of range",
   45: "Level 2 not synchronized",
   46: "Level 3 halted",
   47: "Level 3 reset",
   48: "Link number out of range",
   49: "Protocol driver not attached",
   50: "No CSI structure available",
   51: "Level 2 halted",
   52: "Invalid exchange",
   53: "Invalid request descriptor",
   54: "Exchange full",
   55: "No anode",
   56: "Invalid request code",
   57: "Invalid slot",
   59: "Bad font file fmt",
   60: "Device not a stream",
   61: "No data (for no delay io)",
   62: "Timer expired",
   63: "Out of streams resources",
   64: "Machine is not on the network",
   65: "Package not installed",
   66: "The object is remote",
   67: "The link has been severed",
   68: "Advertise error",
   69: "Srmount error",
   70: "Communication error on send",
   71: "Protocol error",
   72: "Multihop attempted",
   73: "Cross mount point (not really error)",
   74: "Trying to read unreadable message",
   75: "Value too large for defined data type",
   76: "Given log. name not unique",
   77: "f.d. invalid for this operation",
   78: "Remote address changed",
   79: "Can   access a needed shared lib",
   80: "Accessing a corrupted shared lib",
   81: ".lib section in a.out corrupted",
   82: "Attempting to link in too many libs",
   83: "Attempting to exec a shared library",
   84: "Illegal byte sequence",
   86: "Streams pipe error",
   87: "Too many users",
   88: "Socket operation on non-socket",
   89: "Destination address required",
   90: "Message too long",
   91: "Protocol wrong type for socket",
   92: "Protocol not available",
   93: "Unknown protocol",
   94: "Socket type not supported",
   95: "Not supported",
   96: "Protocol family not supported",
   97: "Address family not supported by protocol family",
   98: "Address already in use",
   99: "Address not available",
   100: "Network interface is not configured",
   101: "Network is unreachable",
   102: "Connection reset by network",
   103: "Connection aborted",
   104: "Connection reset by peer",
   105: "No buffer space available",
   106: "Socket is already connected",
   107: "Socket is not connected",
   108: "Can't send after socket shutdown",
   109: "Too many references",
   110: "Connection timed out",
   111: "Connection refused",
   112: "Host is down",
   113: "Host is unreachable",
   114: "Socket already connected",
   115: "Connection already in progress",
   116: "Stale file handle",
   122: "Quota exceeded",
   123: "No medium (in tape drive)",
   125: "Operation canceled",
   130: "Previous owner died",
   131: "State not recoverable"
  };
  function ___setErrNo(value) {
   if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value;
   return value;
  }
  var PATH = {
   splitPath: (function(filename) {
    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
    return splitPathRe.exec(filename).slice(1);
   }),
   normalizeArray: (function(parts, allowAboveRoot) {
    var up = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
     var last = parts[i];
     if (last === ".") {
      parts.splice(i, 1);
     } else if (last === "..") {
      parts.splice(i, 1);
      up++;
     } else if (up) {
      parts.splice(i, 1);
      up--;
     }
    }
    if (allowAboveRoot) {
     for (; up--; up) {
      parts.unshift("..");
     }
    }
    return parts;
   }),
   normalize: (function(path) {
    var isAbsolute = path.charAt(0) === "/", trailingSlash = path.substr(-1) === "/";
    path = PATH.normalizeArray(path.split("/").filter((function(p) {
     return !!p;
    })), !isAbsolute).join("/");
    if (!path && !isAbsolute) {
     path = ".";
    }
    if (path && trailingSlash) {
     path += "/";
    }
    return (isAbsolute ? "/" : "") + path;
   }),
   dirname: (function(path) {
    var result = PATH.splitPath(path), root = result[0], dir = result[1];
    if (!root && !dir) {
     return ".";
    }
    if (dir) {
     dir = dir.substr(0, dir.length - 1);
    }
    return root + dir;
   }),
   basename: (function(path) {
    if (path === "/") return "/";
    var lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) return path;
    return path.substr(lastSlash + 1);
   }),
   extname: (function(path) {
    return PATH.splitPath(path)[3];
   }),
   join: (function() {
    var paths = Array.prototype.slice.call(arguments, 0);
    return PATH.normalize(paths.join("/"));
   }),
   join2: (function(l, r) {
    return PATH.normalize(l + "/" + r);
   }),
   resolve: (function() {
    var resolvedPath = "", resolvedAbsolute = false;
    for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
     var path = i >= 0 ? arguments[i] : FS.cwd();
     if (typeof path !== "string") {
      throw new TypeError("Arguments to path.resolve must be strings");
     } else if (!path) {
      return "";
     }
     resolvedPath = path + "/" + resolvedPath;
     resolvedAbsolute = path.charAt(0) === "/";
    }
    resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((function(p) {
     return !!p;
    })), !resolvedAbsolute).join("/");
    return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
   }),
   relative: (function(from, to) {
    from = PATH.resolve(from).substr(1);
    to = PATH.resolve(to).substr(1);
    function trim(arr) {
     var start = 0;
     for (; start < arr.length; start++) {
      if (arr[start] !== "") break;
     }
     var end = arr.length - 1;
     for (; end >= 0; end--) {
      if (arr[end] !== "") break;
     }
     if (start > end) return [];
     return arr.slice(start, end - start + 1);
    }
    var fromParts = trim(from.split("/"));
    var toParts = trim(to.split("/"));
    var length = Math.min(fromParts.length, toParts.length);
    var samePartsLength = length;
    for (var i = 0; i < length; i++) {
     if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
     }
    }
    var outputParts = [];
    for (var i = samePartsLength; i < fromParts.length; i++) {
     outputParts.push("..");
    }
    outputParts = outputParts.concat(toParts.slice(samePartsLength));
    return outputParts.join("/");
   })
  };
  var TTY = {
   ttys: [],
   init: (function() {}),
   shutdown: (function() {}),
   register: (function(dev, ops) {
    TTY.ttys[dev] = {
     input: [],
     output: [],
     ops: ops
    };
    FS.registerDevice(dev, TTY.stream_ops);
   }),
   stream_ops: {
    open: (function(stream) {
     var tty = TTY.ttys[stream.node.rdev];
     if (!tty) {
      throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
     }
     stream.tty = tty;
     stream.seekable = false;
    }),
    close: (function(stream) {
     stream.tty.ops.flush(stream.tty);
    }),
    flush: (function(stream) {
     stream.tty.ops.flush(stream.tty);
    }),
    read: (function(stream, buffer, offset, length, pos) {
     if (!stream.tty || !stream.tty.ops.get_char) {
      throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
     }
     var bytesRead = 0;
     for (var i = 0; i < length; i++) {
      var result;
      try {
       result = stream.tty.ops.get_char(stream.tty);
      } catch (e) {
       throw new FS.ErrnoError(ERRNO_CODES.EIO);
      }
      if (result === undefined && bytesRead === 0) {
       throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
      }
      if (result === null || result === undefined) break;
      bytesRead++;
      buffer[offset + i] = result;
     }
     if (bytesRead) {
      stream.node.timestamp = Date.now();
     }
     return bytesRead;
    }),
    write: (function(stream, buffer, offset, length, pos) {
     if (!stream.tty || !stream.tty.ops.put_char) {
      throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
     }
     for (var i = 0; i < length; i++) {
      try {
       stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
      } catch (e) {
       throw new FS.ErrnoError(ERRNO_CODES.EIO);
      }
     }
     if (length) {
      stream.node.timestamp = Date.now();
     }
     return i;
    })
   },
   default_tty_ops: {
    get_char: (function(tty) {
     if (!tty.input.length) {
      var result = null;
      if (ENVIRONMENT_IS_NODE) {
       var BUFSIZE = 256;
       var buf = new Buffer(BUFSIZE);
       var bytesRead = 0;
       var isPosixPlatform = process.platform != "win32";
       var fd = process.stdin.fd;
       if (isPosixPlatform) {
        var usingDevice = false;
        try {
         fd = fs$1.openSync("/dev/stdin", "r");
         usingDevice = true;
        } catch (e) {}
       }
       try {
        bytesRead = fs$1.readSync(fd, buf, 0, BUFSIZE, null);
       } catch (e) {
        if (e.toString().indexOf("EOF") != -1) bytesRead = 0; else throw e;
       }
       if (usingDevice) {
        fs$1.closeSync(fd);
       }
       if (bytesRead > 0) {
        result = buf.slice(0, bytesRead).toString("utf-8");
       } else {
        result = null;
       }
      } else if (typeof window != "undefined" && typeof window.prompt == "function") {
       result = window.prompt("Input: ");
       if (result !== null) {
        result += "\n";
       }
      } else if (typeof readline == "function") {
       result = readline();
       if (result !== null) {
        result += "\n";
       }
      }
      if (!result) {
       return null;
      }
      tty.input = intArrayFromString(result, true);
     }
     return tty.input.shift();
    }),
    put_char: (function(tty, val) {
     if (val === null || val === 10) {
      Module["print"](UTF8ArrayToString(tty.output, 0));
      tty.output = [];
     } else {
      if (val != 0) tty.output.push(val);
     }
    }),
    flush: (function(tty) {
     if (tty.output && tty.output.length > 0) {
      Module["print"](UTF8ArrayToString(tty.output, 0));
      tty.output = [];
     }
    })
   },
   default_tty1_ops: {
    put_char: (function(tty, val) {
     if (val === null || val === 10) {
      Module["printErr"](UTF8ArrayToString(tty.output, 0));
      tty.output = [];
     } else {
      if (val != 0) tty.output.push(val);
     }
    }),
    flush: (function(tty) {
     if (tty.output && tty.output.length > 0) {
      Module["printErr"](UTF8ArrayToString(tty.output, 0));
      tty.output = [];
     }
    })
   }
  };
  var MEMFS = {
   ops_table: null,
   mount: (function(mount) {
    return MEMFS.createNode(null, "/", 16384 | 511, 0);
   }),
   createNode: (function(parent, name, mode, dev) {
    if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (!MEMFS.ops_table) {
     MEMFS.ops_table = {
      dir: {
       node: {
        getattr: MEMFS.node_ops.getattr,
        setattr: MEMFS.node_ops.setattr,
        lookup: MEMFS.node_ops.lookup,
        mknod: MEMFS.node_ops.mknod,
        rename: MEMFS.node_ops.rename,
        unlink: MEMFS.node_ops.unlink,
        rmdir: MEMFS.node_ops.rmdir,
        readdir: MEMFS.node_ops.readdir,
        symlink: MEMFS.node_ops.symlink
       },
       stream: {
        llseek: MEMFS.stream_ops.llseek
       }
      },
      file: {
       node: {
        getattr: MEMFS.node_ops.getattr,
        setattr: MEMFS.node_ops.setattr
       },
       stream: {
        llseek: MEMFS.stream_ops.llseek,
        read: MEMFS.stream_ops.read,
        write: MEMFS.stream_ops.write,
        allocate: MEMFS.stream_ops.allocate,
        mmap: MEMFS.stream_ops.mmap,
        msync: MEMFS.stream_ops.msync
       }
      },
      link: {
       node: {
        getattr: MEMFS.node_ops.getattr,
        setattr: MEMFS.node_ops.setattr,
        readlink: MEMFS.node_ops.readlink
       },
       stream: {}
      },
      chrdev: {
       node: {
        getattr: MEMFS.node_ops.getattr,
        setattr: MEMFS.node_ops.setattr
       },
       stream: FS.chrdev_stream_ops
      }
     };
    }
    var node = FS.createNode(parent, name, mode, dev);
    if (FS.isDir(node.mode)) {
     node.node_ops = MEMFS.ops_table.dir.node;
     node.stream_ops = MEMFS.ops_table.dir.stream;
     node.contents = {};
    } else if (FS.isFile(node.mode)) {
     node.node_ops = MEMFS.ops_table.file.node;
     node.stream_ops = MEMFS.ops_table.file.stream;
     node.usedBytes = 0;
     node.contents = null;
    } else if (FS.isLink(node.mode)) {
     node.node_ops = MEMFS.ops_table.link.node;
     node.stream_ops = MEMFS.ops_table.link.stream;
    } else if (FS.isChrdev(node.mode)) {
     node.node_ops = MEMFS.ops_table.chrdev.node;
     node.stream_ops = MEMFS.ops_table.chrdev.stream;
    }
    node.timestamp = Date.now();
    if (parent) {
     parent.contents[name] = node;
    }
    return node;
   }),
   getFileDataAsRegularArray: (function(node) {
    if (node.contents && node.contents.subarray) {
     var arr = [];
     for (var i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]);
     return arr;
    }
    return node.contents;
   }),
   getFileDataAsTypedArray: (function(node) {
    if (!node.contents) return new Uint8Array;
    if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
    return new Uint8Array(node.contents);
   }),
   expandFileStorage: (function(node, newCapacity) {
    if (node.contents && node.contents.subarray && newCapacity > node.contents.length) {
     node.contents = MEMFS.getFileDataAsRegularArray(node);
     node.usedBytes = node.contents.length;
    }
    if (!node.contents || node.contents.subarray) {
     var prevCapacity = node.contents ? node.contents.length : 0;
     if (prevCapacity >= newCapacity) return;
     var CAPACITY_DOUBLING_MAX = 1024 * 1024;
     newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) | 0);
     if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
     var oldContents = node.contents;
     node.contents = new Uint8Array(newCapacity);
     if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
     return;
    }
    if (!node.contents && newCapacity > 0) node.contents = [];
    while (node.contents.length < newCapacity) node.contents.push(0);
   }),
   resizeFileStorage: (function(node, newSize) {
    if (node.usedBytes == newSize) return;
    if (newSize == 0) {
     node.contents = null;
     node.usedBytes = 0;
     return;
    }
    if (!node.contents || node.contents.subarray) {
     var oldContents = node.contents;
     node.contents = new Uint8Array(new ArrayBuffer(newSize));
     if (oldContents) {
      node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
     }
     node.usedBytes = newSize;
     return;
    }
    if (!node.contents) node.contents = [];
    if (node.contents.length > newSize) node.contents.length = newSize; else while (node.contents.length < newSize) node.contents.push(0);
    node.usedBytes = newSize;
   }),
   node_ops: {
    getattr: (function(node) {
     var attr = {};
     attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
     attr.ino = node.id;
     attr.mode = node.mode;
     attr.nlink = 1;
     attr.uid = 0;
     attr.gid = 0;
     attr.rdev = node.rdev;
     if (FS.isDir(node.mode)) {
      attr.size = 4096;
     } else if (FS.isFile(node.mode)) {
      attr.size = node.usedBytes;
     } else if (FS.isLink(node.mode)) {
      attr.size = node.link.length;
     } else {
      attr.size = 0;
     }
     attr.atime = new Date(node.timestamp);
     attr.mtime = new Date(node.timestamp);
     attr.ctime = new Date(node.timestamp);
     attr.blksize = 4096;
     attr.blocks = Math.ceil(attr.size / attr.blksize);
     return attr;
    }),
    setattr: (function(node, attr) {
     if (attr.mode !== undefined) {
      node.mode = attr.mode;
     }
     if (attr.timestamp !== undefined) {
      node.timestamp = attr.timestamp;
     }
     if (attr.size !== undefined) {
      MEMFS.resizeFileStorage(node, attr.size);
     }
    }),
    lookup: (function(parent, name) {
     throw FS.genericErrors[ERRNO_CODES.ENOENT];
    }),
    mknod: (function(parent, name, mode, dev) {
     return MEMFS.createNode(parent, name, mode, dev);
    }),
    rename: (function(old_node, new_dir, new_name) {
     if (FS.isDir(old_node.mode)) {
      var new_node;
      try {
       new_node = FS.lookupNode(new_dir, new_name);
      } catch (e) {}
      if (new_node) {
       for (var i in new_node.contents) {
        throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
       }
      }
     }
     delete old_node.parent.contents[old_node.name];
     old_node.name = new_name;
     new_dir.contents[new_name] = old_node;
     old_node.parent = new_dir;
    }),
    unlink: (function(parent, name) {
     delete parent.contents[name];
    }),
    rmdir: (function(parent, name) {
     var node = FS.lookupNode(parent, name);
     for (var i in node.contents) {
      throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
     }
     delete parent.contents[name];
    }),
    readdir: (function(node) {
     var entries = [ ".", ".." ];
     for (var key in node.contents) {
      if (!node.contents.hasOwnProperty(key)) {
       continue;
      }
      entries.push(key);
     }
     return entries;
    }),
    symlink: (function(parent, newname, oldpath) {
     var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
     node.link = oldpath;
     return node;
    }),
    readlink: (function(node) {
     if (!FS.isLink(node.mode)) {
      throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
     }
     return node.link;
    })
   },
   stream_ops: {
    read: (function(stream, buffer, offset, length, position) {
     var contents = stream.node.contents;
     if (position >= stream.node.usedBytes) return 0;
     var size = Math.min(stream.node.usedBytes - position, length);
     assert(size >= 0);
     if (size > 8 && contents.subarray) {
      buffer.set(contents.subarray(position, position + size), offset);
     } else {
      for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
     }
     return size;
    }),
    write: (function(stream, buffer, offset, length, position, canOwn) {
     if (!length) return 0;
     var node = stream.node;
     node.timestamp = Date.now();
     if (buffer.subarray && (!node.contents || node.contents.subarray)) {
      if (canOwn) {
       node.contents = buffer.subarray(offset, offset + length);
       node.usedBytes = length;
       return length;
      } else if (node.usedBytes === 0 && position === 0) {
       node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
       node.usedBytes = length;
       return length;
      } else if (position + length <= node.usedBytes) {
       node.contents.set(buffer.subarray(offset, offset + length), position);
       return length;
      }
     }
     MEMFS.expandFileStorage(node, position + length);
     if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position); else {
      for (var i = 0; i < length; i++) {
       node.contents[position + i] = buffer[offset + i];
      }
     }
     node.usedBytes = Math.max(node.usedBytes, position + length);
     return length;
    }),
    llseek: (function(stream, offset, whence) {
     var position = offset;
     if (whence === 1) {
      position += stream.position;
     } else if (whence === 2) {
      if (FS.isFile(stream.node.mode)) {
       position += stream.node.usedBytes;
      }
     }
     if (position < 0) {
      throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
     }
     return position;
    }),
    allocate: (function(stream, offset, length) {
     MEMFS.expandFileStorage(stream.node, offset + length);
     stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
    }),
    mmap: (function(stream, buffer, offset, length, position, prot, flags) {
     if (!FS.isFile(stream.node.mode)) {
      throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
     }
     var ptr;
     var allocated;
     var contents = stream.node.contents;
     if (!(flags & 2) && (contents.buffer === buffer || contents.buffer === buffer.buffer)) {
      allocated = false;
      ptr = contents.byteOffset;
     } else {
      if (position > 0 || position + length < stream.node.usedBytes) {
       if (contents.subarray) {
        contents = contents.subarray(position, position + length);
       } else {
        contents = Array.prototype.slice.call(contents, position, position + length);
       }
      }
      allocated = true;
      ptr = _malloc(length);
      if (!ptr) {
       throw new FS.ErrnoError(ERRNO_CODES.ENOMEM);
      }
      buffer.set(contents, ptr);
     }
     return {
      ptr: ptr,
      allocated: allocated
     };
    }),
    msync: (function(stream, buffer, offset, length, mmapFlags) {
     if (!FS.isFile(stream.node.mode)) {
      throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
     }
     if (mmapFlags & 2) {
      return 0;
     }
     var bytesWritten = MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
     return 0;
    })
   }
  };
  var IDBFS = {
   dbs: {},
   indexedDB: (function() {
    if (typeof indexedDB !== "undefined") return indexedDB;
    var ret = null;
    if (typeof window === "object") ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    assert(ret, "IDBFS used, but indexedDB not supported");
    return ret;
   }),
   DB_VERSION: 21,
   DB_STORE_NAME: "FILE_DATA",
   mount: (function(mount) {
    return MEMFS.mount.apply(null, arguments);
   }),
   syncfs: (function(mount, populate, callback) {
    IDBFS.getLocalSet(mount, (function(err, local) {
     if (err) return callback(err);
     IDBFS.getRemoteSet(mount, (function(err, remote) {
      if (err) return callback(err);
      var src = populate ? remote : local;
      var dst = populate ? local : remote;
      IDBFS.reconcile(src, dst, callback);
     }));
    }));
   }),
   getDB: (function(name, callback) {
    var db = IDBFS.dbs[name];
    if (db) {
     return callback(null, db);
    }
    var req;
    try {
     req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
    } catch (e) {
     return callback(e);
    }
    if (!req) {
     return callback("Unable to connect to IndexedDB");
    }
    req.onupgradeneeded = (function(e) {
     var db = e.target.result;
     var transaction = e.target.transaction;
     var fileStore;
     if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
      fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
     } else {
      fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
     }
     if (!fileStore.indexNames.contains("timestamp")) {
      fileStore.createIndex("timestamp", "timestamp", {
       unique: false
      });
     }
    });
    req.onsuccess = (function() {
     db = req.result;
     IDBFS.dbs[name] = db;
     callback(null, db);
    });
    req.onerror = (function(e) {
     callback(this.error);
     e.preventDefault();
    });
   }),
   getLocalSet: (function(mount, callback) {
    var entries = {};
    function isRealDir(p) {
     return p !== "." && p !== "..";
    }
    function toAbsolute(root) {
     return (function(p) {
      return PATH.join2(root, p);
     });
    }
    var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
    while (check.length) {
     var path = check.pop();
     var stat;
     try {
      stat = FS.stat(path);
     } catch (e) {
      return callback(e);
     }
     if (FS.isDir(stat.mode)) {
      check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
     }
     entries[path] = {
      timestamp: stat.mtime
     };
    }
    return callback(null, {
     type: "local",
     entries: entries
    });
   }),
   getRemoteSet: (function(mount, callback) {
    var entries = {};
    IDBFS.getDB(mount.mountpoint, (function(err, db) {
     if (err) return callback(err);
     var transaction = db.transaction([ IDBFS.DB_STORE_NAME ], "readonly");
     transaction.onerror = (function(e) {
      callback(this.error);
      e.preventDefault();
     });
     var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
     var index = store.index("timestamp");
     index.openKeyCursor().onsuccess = (function(event) {
      var cursor = event.target.result;
      if (!cursor) {
       return callback(null, {
        type: "remote",
        db: db,
        entries: entries
       });
      }
      entries[cursor.primaryKey] = {
       timestamp: cursor.key
      };
      cursor.continue();
     });
    }));
   }),
   loadLocalEntry: (function(path, callback) {
    var stat, node;
    try {
     var lookup = FS.lookupPath(path);
     node = lookup.node;
     stat = FS.stat(path);
    } catch (e) {
     return callback(e);
    }
    if (FS.isDir(stat.mode)) {
     return callback(null, {
      timestamp: stat.mtime,
      mode: stat.mode
     });
    } else if (FS.isFile(stat.mode)) {
     node.contents = MEMFS.getFileDataAsTypedArray(node);
     return callback(null, {
      timestamp: stat.mtime,
      mode: stat.mode,
      contents: node.contents
     });
    } else {
     return callback(new Error("node type not supported"));
    }
   }),
   storeLocalEntry: (function(path, entry, callback) {
    try {
     if (FS.isDir(entry.mode)) {
      FS.mkdir(path, entry.mode);
     } else if (FS.isFile(entry.mode)) {
      FS.writeFile(path, entry.contents, {
       encoding: "binary",
       canOwn: true
      });
     } else {
      return callback(new Error("node type not supported"));
     }
     FS.chmod(path, entry.mode);
     FS.utime(path, entry.timestamp, entry.timestamp);
    } catch (e) {
     return callback(e);
    }
    callback(null);
   }),
   removeLocalEntry: (function(path, callback) {
    try {
     var lookup = FS.lookupPath(path);
     var stat = FS.stat(path);
     if (FS.isDir(stat.mode)) {
      FS.rmdir(path);
     } else if (FS.isFile(stat.mode)) {
      FS.unlink(path);
     }
    } catch (e) {
     return callback(e);
    }
    callback(null);
   }),
   loadRemoteEntry: (function(store, path, callback) {
    var req = store.get(path);
    req.onsuccess = (function(event) {
     callback(null, event.target.result);
    });
    req.onerror = (function(e) {
     callback(this.error);
     e.preventDefault();
    });
   }),
   storeRemoteEntry: (function(store, path, entry, callback) {
    var req = store.put(entry, path);
    req.onsuccess = (function() {
     callback(null);
    });
    req.onerror = (function(e) {
     callback(this.error);
     e.preventDefault();
    });
   }),
   removeRemoteEntry: (function(store, path, callback) {
    var req = store.delete(path);
    req.onsuccess = (function() {
     callback(null);
    });
    req.onerror = (function(e) {
     callback(this.error);
     e.preventDefault();
    });
   }),
   reconcile: (function(src, dst, callback) {
    var total = 0;
    var create = [];
    Object.keys(src.entries).forEach((function(key) {
     var e = src.entries[key];
     var e2 = dst.entries[key];
     if (!e2 || e.timestamp > e2.timestamp) {
      create.push(key);
      total++;
     }
    }));
    var remove = [];
    Object.keys(dst.entries).forEach((function(key) {
     var e = dst.entries[key];
     var e2 = src.entries[key];
     if (!e2) {
      remove.push(key);
      total++;
     }
    }));
    if (!total) {
     return callback(null);
    }
    var completed = 0;
    var db = src.type === "remote" ? src.db : dst.db;
    var transaction = db.transaction([ IDBFS.DB_STORE_NAME ], "readwrite");
    var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
    function done(err) {
     if (err) {
      if (!done.errored) {
       done.errored = true;
       return callback(err);
      }
      return;
     }
     if (++completed >= total) {
      return callback(null);
     }
    }
    transaction.onerror = (function(e) {
     done(this.error);
     e.preventDefault();
    });
    create.sort().forEach((function(path) {
     if (dst.type === "local") {
      IDBFS.loadRemoteEntry(store, path, (function(err, entry) {
       if (err) return done(err);
       IDBFS.storeLocalEntry(path, entry, done);
      }));
     } else {
      IDBFS.loadLocalEntry(path, (function(err, entry) {
       if (err) return done(err);
       IDBFS.storeRemoteEntry(store, path, entry, done);
      }));
     }
    }));
    remove.sort().reverse().forEach((function(path) {
     if (dst.type === "local") {
      IDBFS.removeLocalEntry(path, done);
     } else {
      IDBFS.removeRemoteEntry(store, path, done);
     }
    }));
   })
  };
  var NODEFS = {
   isWindows: false,
   staticInit: (function() {
    NODEFS.isWindows = !!process.platform.match(/^win/);
   }),
   mount: (function(mount) {
    assert(ENVIRONMENT_IS_NODE);
    return NODEFS.createNode(null, "/", NODEFS.getMode(mount.opts.root), 0);
   }),
   createNode: (function(parent, name, mode, dev) {
    if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var node = FS.createNode(parent, name, mode);
    node.node_ops = NODEFS.node_ops;
    node.stream_ops = NODEFS.stream_ops;
    return node;
   }),
   getMode: (function(path) {
    var stat;
    try {
     stat = fs$1.lstatSync(path);
     if (NODEFS.isWindows) {
      stat.mode = stat.mode | (stat.mode & 146) >> 1;
     }
    } catch (e) {
     if (!e.code) throw e;
     throw new FS.ErrnoError(ERRNO_CODES[e.code]);
    }
    return stat.mode;
   }),
   realPath: (function(node) {
    var parts = [];
    while (node.parent !== node) {
     parts.push(node.name);
     node = node.parent;
    }
    parts.push(node.mount.opts.root);
    parts.reverse();
    return PATH.join.apply(null, parts);
   }),
   flagsToPermissionStringMap: {
    0: "r",
    1: "r+",
    2: "r+",
    64: "r",
    65: "r+",
    66: "r+",
    129: "rx+",
    193: "rx+",
    514: "w+",
    577: "w",
    578: "w+",
    705: "wx",
    706: "wx+",
    1024: "a",
    1025: "a",
    1026: "a+",
    1089: "a",
    1090: "a+",
    1153: "ax",
    1154: "ax+",
    1217: "ax",
    1218: "ax+",
    4096: "rs",
    4098: "rs+"
   },
   flagsToPermissionString: (function(flags) {
    flags &= ~2097152;
    flags &= ~2048;
    flags &= ~32768;
    flags &= ~524288;
    if (flags in NODEFS.flagsToPermissionStringMap) {
     return NODEFS.flagsToPermissionStringMap[flags];
    } else {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
   }),
   node_ops: {
    getattr: (function(node) {
     var path = NODEFS.realPath(node);
     var stat;
     try {
      stat = fs$1.lstatSync(path);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
     if (NODEFS.isWindows && !stat.blksize) {
      stat.blksize = 4096;
     }
     if (NODEFS.isWindows && !stat.blocks) {
      stat.blocks = (stat.size + stat.blksize - 1) / stat.blksize | 0;
     }
     return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      rdev: stat.rdev,
      size: stat.size,
      atime: stat.atime,
      mtime: stat.mtime,
      ctime: stat.ctime,
      blksize: stat.blksize,
      blocks: stat.blocks
     };
    }),
    setattr: (function(node, attr) {
     var path = NODEFS.realPath(node);
     try {
      if (attr.mode !== undefined) {
       fs$1.chmodSync(path, attr.mode);
       node.mode = attr.mode;
      }
      if (attr.timestamp !== undefined) {
       var date = new Date(attr.timestamp);
       fs$1.utimesSync(path, date, date);
      }
      if (attr.size !== undefined) {
       fs$1.truncateSync(path, attr.size);
      }
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    lookup: (function(parent, name) {
     var path = PATH.join2(NODEFS.realPath(parent), name);
     var mode = NODEFS.getMode(path);
     return NODEFS.createNode(parent, name, mode);
    }),
    mknod: (function(parent, name, mode, dev) {
     var node = NODEFS.createNode(parent, name, mode, dev);
     var path = NODEFS.realPath(node);
     try {
      if (FS.isDir(node.mode)) {
       fs$1.mkdirSync(path, node.mode);
      } else {
       fs$1.writeFileSync(path, "", {
        mode: node.mode
       });
      }
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
     return node;
    }),
    rename: (function(oldNode, newDir, newName) {
     var oldPath = NODEFS.realPath(oldNode);
     var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
     try {
      fs$1.renameSync(oldPath, newPath);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    unlink: (function(parent, name) {
     var path = PATH.join2(NODEFS.realPath(parent), name);
     try {
      fs$1.unlinkSync(path);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    rmdir: (function(parent, name) {
     var path = PATH.join2(NODEFS.realPath(parent), name);
     try {
      fs$1.rmdirSync(path);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    readdir: (function(node) {
     var path = NODEFS.realPath(node);
     try {
      return fs$1.readdirSync(path);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    symlink: (function(parent, newName, oldPath) {
     var newPath = PATH.join2(NODEFS.realPath(parent), newName);
     try {
      fs$1.symlinkSync(oldPath, newPath);
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    readlink: (function(node) {
     var path = NODEFS.realPath(node);
     try {
      path = fs$1.readlinkSync(path);
      path = NODEJS_PATH.relative(NODEJS_PATH.resolve(node.mount.opts.root), path);
      return path;
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    })
   },
   stream_ops: {
    open: (function(stream) {
     var path = NODEFS.realPath(stream.node);
     try {
      if (FS.isFile(stream.node.mode)) {
       stream.nfd = fs$1.openSync(path, NODEFS.flagsToPermissionString(stream.flags));
      }
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    close: (function(stream) {
     try {
      if (FS.isFile(stream.node.mode) && stream.nfd) {
       fs$1.closeSync(stream.nfd);
      }
     } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
    }),
    read: (function(stream, buffer, offset, length, position) {
     if (length === 0) return 0;
     var nbuffer = new Buffer(length);
     var res;
     try {
      res = fs$1.readSync(stream.nfd, nbuffer, 0, length, position);
     } catch (e) {
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
     if (res > 0) {
      for (var i = 0; i < res; i++) {
       buffer[offset + i] = nbuffer[i];
      }
     }
     return res;
    }),
    write: (function(stream, buffer, offset, length, position) {
     var nbuffer = new Buffer(buffer.subarray(offset, offset + length));
     var res;
     try {
      res = fs$1.writeSync(stream.nfd, nbuffer, 0, length, position);
     } catch (e) {
      throw new FS.ErrnoError(ERRNO_CODES[e.code]);
     }
     return res;
    }),
    llseek: (function(stream, offset, whence) {
     var position = offset;
     if (whence === 1) {
      position += stream.position;
     } else if (whence === 2) {
      if (FS.isFile(stream.node.mode)) {
       try {
        var stat = fs$1.fstatSync(stream.nfd);
        position += stat.size;
       } catch (e) {
        throw new FS.ErrnoError(ERRNO_CODES[e.code]);
       }
      }
     }
     if (position < 0) {
      throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
     }
     return position;
    })
   }
  };
  var WORKERFS = {
   DIR_MODE: 16895,
   FILE_MODE: 33279,
   reader: null,
   mount: (function(mount) {
    assert(ENVIRONMENT_IS_WORKER);
    if (!WORKERFS.reader) WORKERFS.reader = new FileReaderSync;
    var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
    var createdParents = {};
    function ensureParent(path) {
     var parts = path.split("/");
     var parent = root;
     for (var i = 0; i < parts.length - 1; i++) {
      var curr = parts.slice(0, i + 1).join("/");
      if (!createdParents[curr]) {
       createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0);
      }
      parent = createdParents[curr];
     }
     return parent;
    }
    function base(path) {
     var parts = path.split("/");
     return parts[parts.length - 1];
    }
    Array.prototype.forEach.call(mount.opts["files"] || [], (function(file) {
     WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
    }));
    (mount.opts["blobs"] || []).forEach((function(obj) {
     WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]);
    }));
    (mount.opts["packages"] || []).forEach((function(pack) {
     pack["metadata"].files.forEach((function(file) {
      var name = file.filename.substr(1);
      WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack["blob"].slice(file.start, file.end));
     }));
    }));
    return root;
   }),
   createNode: (function(parent, name, mode, dev, contents, mtime) {
    var node = FS.createNode(parent, name, mode);
    node.mode = mode;
    node.node_ops = WORKERFS.node_ops;
    node.stream_ops = WORKERFS.stream_ops;
    node.timestamp = (mtime || new Date).getTime();
    assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
    if (mode === WORKERFS.FILE_MODE) {
     node.size = contents.size;
     node.contents = contents;
    } else {
     node.size = 4096;
     node.contents = {};
    }
    if (parent) {
     parent.contents[name] = node;
    }
    return node;
   }),
   node_ops: {
    getattr: (function(node) {
     return {
      dev: 1,
      ino: undefined,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: undefined,
      size: node.size,
      atime: new Date(node.timestamp),
      mtime: new Date(node.timestamp),
      ctime: new Date(node.timestamp),
      blksize: 4096,
      blocks: Math.ceil(node.size / 4096)
     };
    }),
    setattr: (function(node, attr) {
     if (attr.mode !== undefined) {
      node.mode = attr.mode;
     }
     if (attr.timestamp !== undefined) {
      node.timestamp = attr.timestamp;
     }
    }),
    lookup: (function(parent, name) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }),
    mknod: (function(parent, name, mode, dev) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    rename: (function(oldNode, newDir, newName) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    unlink: (function(parent, name) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    rmdir: (function(parent, name) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    readdir: (function(node) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    symlink: (function(parent, newName, oldPath) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }),
    readlink: (function(node) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    })
   },
   stream_ops: {
    read: (function(stream, buffer, offset, length, position) {
     if (position >= stream.node.size) return 0;
     var chunk = stream.node.contents.slice(position, position + length);
     var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
     buffer.set(new Uint8Array(ab), offset);
     return chunk.size;
    }),
    write: (function(stream, buffer, offset, length, position) {
     throw new FS.ErrnoError(ERRNO_CODES.EIO);
    }),
    llseek: (function(stream, offset, whence) {
     var position = offset;
     if (whence === 1) {
      position += stream.position;
     } else if (whence === 2) {
      if (FS.isFile(stream.node.mode)) {
       position += stream.node.size;
      }
     }
     if (position < 0) {
      throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
     }
     return position;
    })
   }
  };
  STATICTOP += 16;
  STATICTOP += 16;
  STATICTOP += 16;
  var FS = {
   root: null,
   mounts: [],
   devices: [ null ],
   streams: [],
   nextInode: 1,
   nameTable: null,
   currentPath: "/",
   initialized: false,
   ignorePermissions: true,
   trackingDelegate: {},
   tracking: {
    openFlags: {
     READ: 1,
     WRITE: 2
    }
   },
   ErrnoError: null,
   genericErrors: {},
   filesystems: null,
   syncFSRequests: 0,
   handleFSError: (function(e) {
    if (!(e instanceof FS.ErrnoError)) throw e + " : " + stackTrace();
    return ___setErrNo(e.errno);
   }),
   lookupPath: (function(path, opts) {
    path = PATH.resolve(FS.cwd(), path);
    opts = opts || {};
    if (!path) return {
     path: "",
     node: null
    };
    var defaults = {
     follow_mount: true,
     recurse_count: 0
    };
    for (var key in defaults) {
     if (opts[key] === undefined) {
      opts[key] = defaults[key];
     }
    }
    if (opts.recurse_count > 8) {
     throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
    }
    var parts = PATH.normalizeArray(path.split("/").filter((function(p) {
     return !!p;
    })), false);
    var current = FS.root;
    var current_path = "/";
    for (var i = 0; i < parts.length; i++) {
     var islast = i === parts.length - 1;
     if (islast && opts.parent) {
      break;
     }
     current = FS.lookupNode(current, parts[i]);
     current_path = PATH.join2(current_path, parts[i]);
     if (FS.isMountpoint(current)) {
      if (!islast || islast && opts.follow_mount) {
       current = current.mounted.root;
      }
     }
     if (!islast || opts.follow) {
      var count = 0;
      while (FS.isLink(current.mode)) {
       var link = FS.readlink(current_path);
       current_path = PATH.resolve(PATH.dirname(current_path), link);
       var lookup = FS.lookupPath(current_path, {
        recurse_count: opts.recurse_count
       });
       current = lookup.node;
       if (count++ > 40) {
        throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
       }
      }
     }
    }
    return {
     path: current_path,
     node: current
    };
   }),
   getPath: (function(node) {
    var path;
    while (true) {
     if (FS.isRoot(node)) {
      var mount = node.mount.mountpoint;
      if (!path) return mount;
      return mount[mount.length - 1] !== "/" ? mount + "/" + path : mount + path;
     }
     path = path ? node.name + "/" + path : node.name;
     node = node.parent;
    }
   }),
   hashName: (function(parentid, name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
     hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
    }
    return (parentid + hash >>> 0) % FS.nameTable.length;
   }),
   hashAddNode: (function(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    node.name_next = FS.nameTable[hash];
    FS.nameTable[hash] = node;
   }),
   hashRemoveNode: (function(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    if (FS.nameTable[hash] === node) {
     FS.nameTable[hash] = node.name_next;
    } else {
     var current = FS.nameTable[hash];
     while (current) {
      if (current.name_next === node) {
       current.name_next = node.name_next;
       break;
      }
      current = current.name_next;
     }
    }
   }),
   lookupNode: (function(parent, name) {
    var err = FS.mayLookup(parent);
    if (err) {
     throw new FS.ErrnoError(err, parent);
    }
    var hash = FS.hashName(parent.id, name);
    for (var node = FS.nameTable[hash]; node; node = node.name_next) {
     var nodeName = node.name;
     if (node.parent.id === parent.id && nodeName === name) {
      return node;
     }
    }
    return FS.lookup(parent, name);
   }),
   createNode: (function(parent, name, mode, rdev) {
    if (!FS.FSNode) {
     FS.FSNode = (function(parent, name, mode, rdev) {
      if (!parent) {
       parent = this;
      }
      this.parent = parent;
      this.mount = parent.mount;
      this.mounted = null;
      this.id = FS.nextInode++;
      this.name = name;
      this.mode = mode;
      this.node_ops = {};
      this.stream_ops = {};
      this.rdev = rdev;
     });
     FS.FSNode.prototype = {};
     var readMode = 292 | 73;
     var writeMode = 146;
     Object.defineProperties(FS.FSNode.prototype, {
      read: {
       get: (function() {
        return (this.mode & readMode) === readMode;
       }),
       set: (function(val) {
        val ? this.mode |= readMode : this.mode &= ~readMode;
       })
      },
      write: {
       get: (function() {
        return (this.mode & writeMode) === writeMode;
       }),
       set: (function(val) {
        val ? this.mode |= writeMode : this.mode &= ~writeMode;
       })
      },
      isFolder: {
       get: (function() {
        return FS.isDir(this.mode);
       })
      },
      isDevice: {
       get: (function() {
        return FS.isChrdev(this.mode);
       })
      }
     });
    }
    var node = new FS.FSNode(parent, name, mode, rdev);
    FS.hashAddNode(node);
    return node;
   }),
   destroyNode: (function(node) {
    FS.hashRemoveNode(node);
   }),
   isRoot: (function(node) {
    return node === node.parent;
   }),
   isMountpoint: (function(node) {
    return !!node.mounted;
   }),
   isFile: (function(mode) {
    return (mode & 61440) === 32768;
   }),
   isDir: (function(mode) {
    return (mode & 61440) === 16384;
   }),
   isLink: (function(mode) {
    return (mode & 61440) === 40960;
   }),
   isChrdev: (function(mode) {
    return (mode & 61440) === 8192;
   }),
   isBlkdev: (function(mode) {
    return (mode & 61440) === 24576;
   }),
   isFIFO: (function(mode) {
    return (mode & 61440) === 4096;
   }),
   isSocket: (function(mode) {
    return (mode & 49152) === 49152;
   }),
   flagModes: {
    "r": 0,
    "rs": 1052672,
    "r+": 2,
    "w": 577,
    "wx": 705,
    "xw": 705,
    "w+": 578,
    "wx+": 706,
    "xw+": 706,
    "a": 1089,
    "ax": 1217,
    "xa": 1217,
    "a+": 1090,
    "ax+": 1218,
    "xa+": 1218
   },
   modeStringToFlags: (function(str) {
    var flags = FS.flagModes[str];
    if (typeof flags === "undefined") {
     throw new Error("Unknown file open mode: " + str);
    }
    return flags;
   }),
   flagsToPermissionString: (function(flag) {
    var perms = [ "r", "w", "rw" ][flag & 3];
    if (flag & 512) {
     perms += "w";
    }
    return perms;
   }),
   nodePermissions: (function(node, perms) {
    if (FS.ignorePermissions) {
     return 0;
    }
    if (perms.indexOf("r") !== -1 && !(node.mode & 292)) {
     return ERRNO_CODES.EACCES;
    } else if (perms.indexOf("w") !== -1 && !(node.mode & 146)) {
     return ERRNO_CODES.EACCES;
    } else if (perms.indexOf("x") !== -1 && !(node.mode & 73)) {
     return ERRNO_CODES.EACCES;
    }
    return 0;
   }),
   mayLookup: (function(dir) {
    var err = FS.nodePermissions(dir, "x");
    if (err) return err;
    if (!dir.node_ops.lookup) return ERRNO_CODES.EACCES;
    return 0;
   }),
   mayCreate: (function(dir, name) {
    try {
     var node = FS.lookupNode(dir, name);
     return ERRNO_CODES.EEXIST;
    } catch (e) {}
    return FS.nodePermissions(dir, "wx");
   }),
   mayDelete: (function(dir, name, isdir) {
    var node;
    try {
     node = FS.lookupNode(dir, name);
    } catch (e) {
     return e.errno;
    }
    var err = FS.nodePermissions(dir, "wx");
    if (err) {
     return err;
    }
    if (isdir) {
     if (!FS.isDir(node.mode)) {
      return ERRNO_CODES.ENOTDIR;
     }
     if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
      return ERRNO_CODES.EBUSY;
     }
    } else {
     if (FS.isDir(node.mode)) {
      return ERRNO_CODES.EISDIR;
     }
    }
    return 0;
   }),
   mayOpen: (function(node, flags) {
    if (!node) {
     return ERRNO_CODES.ENOENT;
    }
    if (FS.isLink(node.mode)) {
     return ERRNO_CODES.ELOOP;
    } else if (FS.isDir(node.mode)) {
     if (FS.flagsToPermissionString(flags) !== "r" || flags & 512) {
      return ERRNO_CODES.EISDIR;
     }
    }
    return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
   }),
   MAX_OPEN_FDS: 4096,
   nextfd: (function(fd_start, fd_end) {
    fd_start = fd_start || 0;
    fd_end = fd_end || FS.MAX_OPEN_FDS;
    for (var fd = fd_start; fd <= fd_end; fd++) {
     if (!FS.streams[fd]) {
      return fd;
     }
    }
    throw new FS.ErrnoError(ERRNO_CODES.EMFILE);
   }),
   getStream: (function(fd) {
    return FS.streams[fd];
   }),
   createStream: (function(stream, fd_start, fd_end) {
    if (!FS.FSStream) {
     FS.FSStream = (function() {});
     FS.FSStream.prototype = {};
     Object.defineProperties(FS.FSStream.prototype, {
      object: {
       get: (function() {
        return this.node;
       }),
       set: (function(val) {
        this.node = val;
       })
      },
      isRead: {
       get: (function() {
        return (this.flags & 2097155) !== 1;
       })
      },
      isWrite: {
       get: (function() {
        return (this.flags & 2097155) !== 0;
       })
      },
      isAppend: {
       get: (function() {
        return this.flags & 1024;
       })
      }
     });
    }
    var newStream = new FS.FSStream;
    for (var p in stream) {
     newStream[p] = stream[p];
    }
    stream = newStream;
    var fd = FS.nextfd(fd_start, fd_end);
    stream.fd = fd;
    FS.streams[fd] = stream;
    return stream;
   }),
   closeStream: (function(fd) {
    FS.streams[fd] = null;
   }),
   chrdev_stream_ops: {
    open: (function(stream) {
     var device = FS.getDevice(stream.node.rdev);
     stream.stream_ops = device.stream_ops;
     if (stream.stream_ops.open) {
      stream.stream_ops.open(stream);
     }
    }),
    llseek: (function() {
     throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
    })
   },
   major: (function(dev) {
    return dev >> 8;
   }),
   minor: (function(dev) {
    return dev & 255;
   }),
   makedev: (function(ma, mi) {
    return ma << 8 | mi;
   }),
   registerDevice: (function(dev, ops) {
    FS.devices[dev] = {
     stream_ops: ops
    };
   }),
   getDevice: (function(dev) {
    return FS.devices[dev];
   }),
   getMounts: (function(mount) {
    var mounts = [];
    var check = [ mount ];
    while (check.length) {
     var m = check.pop();
     mounts.push(m);
     check.push.apply(check, m.mounts);
    }
    return mounts;
   }),
   syncfs: (function(populate, callback) {
    if (typeof populate === "function") {
     callback = populate;
     populate = false;
    }
    FS.syncFSRequests++;
    if (FS.syncFSRequests > 1) {
     console.log("warning: " + FS.syncFSRequests + " FS.syncfs operations in flight at once, probably just doing extra work");
    }
    var mounts = FS.getMounts(FS.root.mount);
    var completed = 0;
    function doCallback(err) {
     assert(FS.syncFSRequests > 0);
     FS.syncFSRequests--;
     return callback(err);
    }
    function done(err) {
     if (err) {
      if (!done.errored) {
       done.errored = true;
       return doCallback(err);
      }
      return;
     }
     if (++completed >= mounts.length) {
      doCallback(null);
     }
    }
    mounts.forEach((function(mount) {
     if (!mount.type.syncfs) {
      return done(null);
     }
     mount.type.syncfs(mount, populate, done);
    }));
   }),
   mount: (function(type, opts, mountpoint) {
    var root = mountpoint === "/";
    var pseudo = !mountpoint;
    var node;
    if (root && FS.root) {
     throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
    } else if (!root && !pseudo) {
     var lookup = FS.lookupPath(mountpoint, {
      follow_mount: false
     });
     mountpoint = lookup.path;
     node = lookup.node;
     if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
     }
     if (!FS.isDir(node.mode)) {
      throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
     }
    }
    var mount = {
     type: type,
     opts: opts,
     mountpoint: mountpoint,
     mounts: []
    };
    var mountRoot = type.mount(mount);
    mountRoot.mount = mount;
    mount.root = mountRoot;
    if (root) {
     FS.root = mountRoot;
    } else if (node) {
     node.mounted = mount;
     if (node.mount) {
      node.mount.mounts.push(mount);
     }
    }
    return mountRoot;
   }),
   unmount: (function(mountpoint) {
    var lookup = FS.lookupPath(mountpoint, {
     follow_mount: false
    });
    if (!FS.isMountpoint(lookup.node)) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var node = lookup.node;
    var mount = node.mounted;
    var mounts = FS.getMounts(mount);
    Object.keys(FS.nameTable).forEach((function(hash) {
     var current = FS.nameTable[hash];
     while (current) {
      var next = current.name_next;
      if (mounts.indexOf(current.mount) !== -1) {
       FS.destroyNode(current);
      }
      current = next;
     }
    }));
    node.mounted = null;
    var idx = node.mount.mounts.indexOf(mount);
    assert(idx !== -1);
    node.mount.mounts.splice(idx, 1);
   }),
   lookup: (function(parent, name) {
    return parent.node_ops.lookup(parent, name);
   }),
   mknod: (function(path, mode, dev) {
    var lookup = FS.lookupPath(path, {
     parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    if (!name || name === "." || name === "..") {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var err = FS.mayCreate(parent, name);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    if (!parent.node_ops.mknod) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    return parent.node_ops.mknod(parent, name, mode, dev);
   }),
   create: (function(path, mode) {
    mode = mode !== undefined ? mode : 438;
    mode &= 4095;
    mode |= 32768;
    return FS.mknod(path, mode, 0);
   }),
   mkdir: (function(path, mode) {
    mode = mode !== undefined ? mode : 511;
    mode &= 511 | 512;
    mode |= 16384;
    return FS.mknod(path, mode, 0);
   }),
   mkdirTree: (function(path, mode) {
    var dirs = path.split("/");
    var d = "";
    for (var i = 0; i < dirs.length; ++i) {
     if (!dirs[i]) continue;
     d += "/" + dirs[i];
     try {
      FS.mkdir(d, mode);
     } catch (e) {
      if (e.errno != ERRNO_CODES.EEXIST) throw e;
     }
    }
   }),
   mkdev: (function(path, mode, dev) {
    if (typeof dev === "undefined") {
     dev = mode;
     mode = 438;
    }
    mode |= 8192;
    return FS.mknod(path, mode, dev);
   }),
   symlink: (function(oldpath, newpath) {
    if (!PATH.resolve(oldpath)) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    var lookup = FS.lookupPath(newpath, {
     parent: true
    });
    var parent = lookup.node;
    if (!parent) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    var newname = PATH.basename(newpath);
    var err = FS.mayCreate(parent, newname);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    if (!parent.node_ops.symlink) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    return parent.node_ops.symlink(parent, newname, oldpath);
   }),
   rename: (function(old_path, new_path) {
    var old_dirname = PATH.dirname(old_path);
    var new_dirname = PATH.dirname(new_path);
    var old_name = PATH.basename(old_path);
    var new_name = PATH.basename(new_path);
    var lookup, old_dir, new_dir;
    try {
     lookup = FS.lookupPath(old_path, {
      parent: true
     });
     old_dir = lookup.node;
     lookup = FS.lookupPath(new_path, {
      parent: true
     });
     new_dir = lookup.node;
    } catch (e) {
     throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
    }
    if (!old_dir || !new_dir) throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    if (old_dir.mount !== new_dir.mount) {
     throw new FS.ErrnoError(ERRNO_CODES.EXDEV);
    }
    var old_node = FS.lookupNode(old_dir, old_name);
    var relative = PATH.relative(old_path, new_dirname);
    if (relative.charAt(0) !== ".") {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    relative = PATH.relative(new_path, old_dirname);
    if (relative.charAt(0) !== ".") {
     throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
    }
    var new_node;
    try {
     new_node = FS.lookupNode(new_dir, new_name);
    } catch (e) {}
    if (old_node === new_node) {
     return;
    }
    var isdir = FS.isDir(old_node.mode);
    var err = FS.mayDelete(old_dir, old_name, isdir);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    err = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    if (!old_dir.node_ops.rename) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
     throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
    }
    if (new_dir !== old_dir) {
     err = FS.nodePermissions(old_dir, "w");
     if (err) {
      throw new FS.ErrnoError(err);
     }
    }
    try {
     if (FS.trackingDelegate["willMovePath"]) {
      FS.trackingDelegate["willMovePath"](old_path, new_path);
     }
    } catch (e) {
     console.log("FS.trackingDelegate['willMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message);
    }
    FS.hashRemoveNode(old_node);
    try {
     old_dir.node_ops.rename(old_node, new_dir, new_name);
    } catch (e) {
     throw e;
    } finally {
     FS.hashAddNode(old_node);
    }
    try {
     if (FS.trackingDelegate["onMovePath"]) FS.trackingDelegate["onMovePath"](old_path, new_path);
    } catch (e) {
     console.log("FS.trackingDelegate['onMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message);
    }
   }),
   rmdir: (function(path) {
    var lookup = FS.lookupPath(path, {
     parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var err = FS.mayDelete(parent, name, true);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    if (!parent.node_ops.rmdir) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (FS.isMountpoint(node)) {
     throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
    }
    try {
     if (FS.trackingDelegate["willDeletePath"]) {
      FS.trackingDelegate["willDeletePath"](path);
     }
    } catch (e) {
     console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message);
    }
    parent.node_ops.rmdir(parent, name);
    FS.destroyNode(node);
    try {
     if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path);
    } catch (e) {
     console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message);
    }
   }),
   readdir: (function(path) {
    var lookup = FS.lookupPath(path, {
     follow: true
    });
    var node = lookup.node;
    if (!node.node_ops.readdir) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
    }
    return node.node_ops.readdir(node);
   }),
   unlink: (function(path) {
    var lookup = FS.lookupPath(path, {
     parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var err = FS.mayDelete(parent, name, false);
    if (err) {
     throw new FS.ErrnoError(err);
    }
    if (!parent.node_ops.unlink) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (FS.isMountpoint(node)) {
     throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
    }
    try {
     if (FS.trackingDelegate["willDeletePath"]) {
      FS.trackingDelegate["willDeletePath"](path);
     }
    } catch (e) {
     console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message);
    }
    parent.node_ops.unlink(parent, name);
    FS.destroyNode(node);
    try {
     if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path);
    } catch (e) {
     console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message);
    }
   }),
   readlink: (function(path) {
    var lookup = FS.lookupPath(path);
    var link = lookup.node;
    if (!link) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    if (!link.node_ops.readlink) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    return PATH.resolve(FS.getPath(link.parent), link.node_ops.readlink(link));
   }),
   stat: (function(path, dontFollow) {
    var lookup = FS.lookupPath(path, {
     follow: !dontFollow
    });
    var node = lookup.node;
    if (!node) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    if (!node.node_ops.getattr) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    return node.node_ops.getattr(node);
   }),
   lstat: (function(path) {
    return FS.stat(path, true);
   }),
   chmod: (function(path, mode, dontFollow) {
    var node;
    if (typeof path === "string") {
     var lookup = FS.lookupPath(path, {
      follow: !dontFollow
     });
     node = lookup.node;
    } else {
     node = path;
    }
    if (!node.node_ops.setattr) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    node.node_ops.setattr(node, {
     mode: mode & 4095 | node.mode & ~4095,
     timestamp: Date.now()
    });
   }),
   lchmod: (function(path, mode) {
    FS.chmod(path, mode, true);
   }),
   fchmod: (function(fd, mode) {
    var stream = FS.getStream(fd);
    if (!stream) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    FS.chmod(stream.node, mode);
   }),
   chown: (function(path, uid, gid, dontFollow) {
    var node;
    if (typeof path === "string") {
     var lookup = FS.lookupPath(path, {
      follow: !dontFollow
     });
     node = lookup.node;
    } else {
     node = path;
    }
    if (!node.node_ops.setattr) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    node.node_ops.setattr(node, {
     timestamp: Date.now()
    });
   }),
   lchown: (function(path, uid, gid) {
    FS.chown(path, uid, gid, true);
   }),
   fchown: (function(fd, uid, gid) {
    var stream = FS.getStream(fd);
    if (!stream) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    FS.chown(stream.node, uid, gid);
   }),
   truncate: (function(path, len) {
    if (len < 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var node;
    if (typeof path === "string") {
     var lookup = FS.lookupPath(path, {
      follow: true
     });
     node = lookup.node;
    } else {
     node = path;
    }
    if (!node.node_ops.setattr) {
     throw new FS.ErrnoError(ERRNO_CODES.EPERM);
    }
    if (FS.isDir(node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
    }
    if (!FS.isFile(node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var err = FS.nodePermissions(node, "w");
    if (err) {
     throw new FS.ErrnoError(err);
    }
    node.node_ops.setattr(node, {
     size: len,
     timestamp: Date.now()
    });
   }),
   ftruncate: (function(fd, len) {
    var stream = FS.getStream(fd);
    if (!stream) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    if ((stream.flags & 2097155) === 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    FS.truncate(stream.node, len);
   }),
   utime: (function(path, atime, mtime) {
    var lookup = FS.lookupPath(path, {
     follow: true
    });
    var node = lookup.node;
    node.node_ops.setattr(node, {
     timestamp: Math.max(atime, mtime)
    });
   }),
   open: (function(path, flags, mode, fd_start, fd_end) {
    if (path === "") {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    flags = typeof flags === "string" ? FS.modeStringToFlags(flags) : flags;
    mode = typeof mode === "undefined" ? 438 : mode;
    if (flags & 64) {
     mode = mode & 4095 | 32768;
    } else {
     mode = 0;
    }
    var node;
    if (typeof path === "object") {
     node = path;
    } else {
     path = PATH.normalize(path);
     try {
      var lookup = FS.lookupPath(path, {
       follow: !(flags & 131072)
      });
      node = lookup.node;
     } catch (e) {}
    }
    var created = false;
    if (flags & 64) {
     if (node) {
      if (flags & 128) {
       throw new FS.ErrnoError(ERRNO_CODES.EEXIST);
      }
     } else {
      node = FS.mknod(path, mode, 0);
      created = true;
     }
    }
    if (!node) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    if (FS.isChrdev(node.mode)) {
     flags &= ~512;
    }
    if (flags & 65536 && !FS.isDir(node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
    }
    if (!created) {
     var err = FS.mayOpen(node, flags);
     if (err) {
      throw new FS.ErrnoError(err);
     }
    }
    if (flags & 512) {
     FS.truncate(node, 0);
    }
    flags &= ~(128 | 512);
    var stream = FS.createStream({
     node: node,
     path: FS.getPath(node),
     flags: flags,
     seekable: true,
     position: 0,
     stream_ops: node.stream_ops,
     ungotten: [],
     error: false
    }, fd_start, fd_end);
    if (stream.stream_ops.open) {
     stream.stream_ops.open(stream);
    }
    if (Module["logReadFiles"] && !(flags & 1)) {
     if (!FS.readFiles) FS.readFiles = {};
     if (!(path in FS.readFiles)) {
      FS.readFiles[path] = 1;
      Module["printErr"]("read file: " + path);
     }
    }
    try {
     if (FS.trackingDelegate["onOpenFile"]) {
      var trackingFlags = 0;
      if ((flags & 2097155) !== 1) {
       trackingFlags |= FS.tracking.openFlags.READ;
      }
      if ((flags & 2097155) !== 0) {
       trackingFlags |= FS.tracking.openFlags.WRITE;
      }
      FS.trackingDelegate["onOpenFile"](path, trackingFlags);
     }
    } catch (e) {
     console.log("FS.trackingDelegate['onOpenFile']('" + path + "', flags) threw an exception: " + e.message);
    }
    return stream;
   }),
   close: (function(stream) {
    if (stream.getdents) stream.getdents = null;
    try {
     if (stream.stream_ops.close) {
      stream.stream_ops.close(stream);
     }
    } catch (e) {
     throw e;
    } finally {
     FS.closeStream(stream.fd);
    }
   }),
   llseek: (function(stream, offset, whence) {
    if (!stream.seekable || !stream.stream_ops.llseek) {
     throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
    }
    stream.position = stream.stream_ops.llseek(stream, offset, whence);
    stream.ungotten = [];
    return stream.position;
   }),
   read: (function(stream, buffer, offset, length, position) {
    if (length < 0 || position < 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    if ((stream.flags & 2097155) === 1) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    if (FS.isDir(stream.node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
    }
    if (!stream.stream_ops.read) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    var seeking = true;
    if (typeof position === "undefined") {
     position = stream.position;
     seeking = false;
    } else if (!stream.seekable) {
     throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
    }
    var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
    if (!seeking) stream.position += bytesRead;
    return bytesRead;
   }),
   write: (function(stream, buffer, offset, length, position, canOwn) {
    if (length < 0 || position < 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    if ((stream.flags & 2097155) === 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    if (FS.isDir(stream.node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
    }
    if (!stream.stream_ops.write) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    if (stream.flags & 1024) {
     FS.llseek(stream, 0, 2);
    }
    var seeking = true;
    if (typeof position === "undefined") {
     position = stream.position;
     seeking = false;
    } else if (!stream.seekable) {
     throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
    }
    var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
    if (!seeking) stream.position += bytesWritten;
    try {
     if (stream.path && FS.trackingDelegate["onWriteToFile"]) FS.trackingDelegate["onWriteToFile"](stream.path);
    } catch (e) {
     console.log("FS.trackingDelegate['onWriteToFile']('" + path + "') threw an exception: " + e.message);
    }
    return bytesWritten;
   }),
   allocate: (function(stream, offset, length) {
    if (offset < 0 || length <= 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
    }
    if ((stream.flags & 2097155) === 0) {
     throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    }
    if (!FS.isFile(stream.node.mode) && !FS.isDir(node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
    }
    if (!stream.stream_ops.allocate) {
     throw new FS.ErrnoError(ERRNO_CODES.EOPNOTSUPP);
    }
    stream.stream_ops.allocate(stream, offset, length);
   }),
   mmap: (function(stream, buffer, offset, length, position, prot, flags) {
    if ((stream.flags & 2097155) === 1) {
     throw new FS.ErrnoError(ERRNO_CODES.EACCES);
    }
    if (!stream.stream_ops.mmap) {
     throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
    }
    return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags);
   }),
   msync: (function(stream, buffer, offset, length, mmapFlags) {
    if (!stream || !stream.stream_ops.msync) {
     return 0;
    }
    return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
   }),
   munmap: (function(stream) {
    return 0;
   }),
   ioctl: (function(stream, cmd, arg) {
    if (!stream.stream_ops.ioctl) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOTTY);
    }
    return stream.stream_ops.ioctl(stream, cmd, arg);
   }),
   readFile: (function(path, opts) {
    opts = opts || {};
    opts.flags = opts.flags || "r";
    opts.encoding = opts.encoding || "binary";
    if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
     throw new Error('Invalid encoding type "' + opts.encoding + '"');
    }
    var ret;
    var stream = FS.open(path, opts.flags);
    var stat = FS.stat(path);
    var length = stat.size;
    var buf = new Uint8Array(length);
    FS.read(stream, buf, 0, length, 0);
    if (opts.encoding === "utf8") {
     ret = UTF8ArrayToString(buf, 0);
    } else if (opts.encoding === "binary") {
     ret = buf;
    }
    FS.close(stream);
    return ret;
   }),
   writeFile: (function(path, data, opts) {
    opts = opts || {};
    opts.flags = opts.flags || "w";
    opts.encoding = opts.encoding || "utf8";
    if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
     throw new Error('Invalid encoding type "' + opts.encoding + '"');
    }
    var stream = FS.open(path, opts.flags, opts.mode);
    if (opts.encoding === "utf8") {
     var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
     var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
     FS.write(stream, buf, 0, actualNumBytes, 0, opts.canOwn);
    } else if (opts.encoding === "binary") {
     FS.write(stream, data, 0, data.length, 0, opts.canOwn);
    }
    FS.close(stream);
   }),
   cwd: (function() {
    return FS.currentPath;
   }),
   chdir: (function(path) {
    var lookup = FS.lookupPath(path, {
     follow: true
    });
    if (lookup.node === null) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
    }
    if (!FS.isDir(lookup.node.mode)) {
     throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
    }
    var err = FS.nodePermissions(lookup.node, "x");
    if (err) {
     throw new FS.ErrnoError(err);
    }
    FS.currentPath = lookup.path;
   }),
   createDefaultDirectories: (function() {
    FS.mkdir("/tmp");
    FS.mkdir("/home");
    FS.mkdir("/home/web_user");
   }),
   createDefaultDevices: (function() {
    FS.mkdir("/dev");
    FS.registerDevice(FS.makedev(1, 3), {
     read: (function() {
      return 0;
     }),
     write: (function(stream, buffer, offset, length, pos) {
      return length;
     })
    });
    FS.mkdev("/dev/null", FS.makedev(1, 3));
    TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
    TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
    FS.mkdev("/dev/tty", FS.makedev(5, 0));
    FS.mkdev("/dev/tty1", FS.makedev(6, 0));
    var random_device;
    if (typeof crypto !== "undefined") {
     var randomBuffer = new Uint8Array(1);
     random_device = (function() {
      crypto.getRandomValues(randomBuffer);
      return randomBuffer[0];
     });
    } else if (ENVIRONMENT_IS_NODE) {
     random_device = (function() {
      return crypto$1.randomBytes(1)[0];
     });
    } else {
     random_device = (function() {
      return Math.random() * 256 | 0;
     });
    }
    FS.createDevice("/dev", "random", random_device);
    FS.createDevice("/dev", "urandom", random_device);
    FS.mkdir("/dev/shm");
    FS.mkdir("/dev/shm/tmp");
   }),
   createSpecialDirectories: (function() {
    FS.mkdir("/proc");
    FS.mkdir("/proc/self");
    FS.mkdir("/proc/self/fd");
    FS.mount({
     mount: (function() {
      var node = FS.createNode("/proc/self", "fd", 16384 | 511, 73);
      node.node_ops = {
       lookup: (function(parent, name) {
        var fd = +name;
        var stream = FS.getStream(fd);
        if (!stream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        var ret = {
         parent: null,
         mount: {
          mountpoint: "fake"
         },
         node_ops: {
          readlink: (function() {
           return stream.path;
          })
         }
        };
        ret.parent = ret;
        return ret;
       })
      };
      return node;
     })
    }, {}, "/proc/self/fd");
   }),
   createStandardStreams: (function() {
    if (Module["stdin"]) {
     FS.createDevice("/dev", "stdin", Module["stdin"]);
    } else {
     FS.symlink("/dev/tty", "/dev/stdin");
    }
    if (Module["stdout"]) {
     FS.createDevice("/dev", "stdout", null, Module["stdout"]);
    } else {
     FS.symlink("/dev/tty", "/dev/stdout");
    }
    if (Module["stderr"]) {
     FS.createDevice("/dev", "stderr", null, Module["stderr"]);
    } else {
     FS.symlink("/dev/tty1", "/dev/stderr");
    }
    var stdin = FS.open("/dev/stdin", "r");
    assert(stdin.fd === 0, "invalid handle for stdin (" + stdin.fd + ")");
    var stdout = FS.open("/dev/stdout", "w");
    assert(stdout.fd === 1, "invalid handle for stdout (" + stdout.fd + ")");
    var stderr = FS.open("/dev/stderr", "w");
    assert(stderr.fd === 2, "invalid handle for stderr (" + stderr.fd + ")");
   }),
   ensureErrnoError: (function() {
    if (FS.ErrnoError) return;
    FS.ErrnoError = function ErrnoError(errno, node) {
     this.node = node;
     this.setErrno = (function(errno) {
      this.errno = errno;
      for (var key in ERRNO_CODES) {
       if (ERRNO_CODES[key] === errno) {
        this.code = key;
        break;
       }
      }
     });
     this.setErrno(errno);
     this.message = ERRNO_MESSAGES[errno];
    };
    FS.ErrnoError.prototype = new Error;
    FS.ErrnoError.prototype.constructor = FS.ErrnoError;
    [ ERRNO_CODES.ENOENT ].forEach((function(code) {
     FS.genericErrors[code] = new FS.ErrnoError(code);
     FS.genericErrors[code].stack = "<generic error, no stack>";
    }));
   }),
   staticInit: (function() {
    FS.ensureErrnoError();
    FS.nameTable = new Array(4096);
    FS.mount(MEMFS, {}, "/");
    FS.createDefaultDirectories();
    FS.createDefaultDevices();
    FS.createSpecialDirectories();
    FS.filesystems = {
     "MEMFS": MEMFS,
     "IDBFS": IDBFS,
     "NODEFS": NODEFS,
     "WORKERFS": WORKERFS
    };
   }),
   init: (function(input, output, error) {
    assert(!FS.init.initialized, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
    FS.init.initialized = true;
    FS.ensureErrnoError();
    Module["stdin"] = input || Module["stdin"];
    Module["stdout"] = output || Module["stdout"];
    Module["stderr"] = error || Module["stderr"];
    FS.createStandardStreams();
   }),
   quit: (function() {
    FS.init.initialized = false;
    var fflush = Module["_fflush"];
    if (fflush) fflush(0);
    for (var i = 0; i < FS.streams.length; i++) {
     var stream = FS.streams[i];
     if (!stream) {
      continue;
     }
     FS.close(stream);
    }
   }),
   getMode: (function(canRead, canWrite) {
    var mode = 0;
    if (canRead) mode |= 292 | 73;
    if (canWrite) mode |= 146;
    return mode;
   }),
   joinPath: (function(parts, forceRelative) {
    var path = PATH.join.apply(null, parts);
    if (forceRelative && path[0] == "/") path = path.substr(1);
    return path;
   }),
   absolutePath: (function(relative, base) {
    return PATH.resolve(base, relative);
   }),
   standardizePath: (function(path) {
    return PATH.normalize(path);
   }),
   findObject: (function(path, dontResolveLastLink) {
    var ret = FS.analyzePath(path, dontResolveLastLink);
    if (ret.exists) {
     return ret.object;
    } else {
     ___setErrNo(ret.error);
     return null;
    }
   }),
   analyzePath: (function(path, dontResolveLastLink) {
    try {
     var lookup = FS.lookupPath(path, {
      follow: !dontResolveLastLink
     });
     path = lookup.path;
    } catch (e) {}
    var ret = {
     isRoot: false,
     exists: false,
     error: 0,
     name: null,
     path: null,
     object: null,
     parentExists: false,
     parentPath: null,
     parentObject: null
    };
    try {
     var lookup = FS.lookupPath(path, {
      parent: true
     });
     ret.parentExists = true;
     ret.parentPath = lookup.path;
     ret.parentObject = lookup.node;
     ret.name = PATH.basename(path);
     lookup = FS.lookupPath(path, {
      follow: !dontResolveLastLink
     });
     ret.exists = true;
     ret.path = lookup.path;
     ret.object = lookup.node;
     ret.name = lookup.node.name;
     ret.isRoot = lookup.path === "/";
    } catch (e) {
     ret.error = e.errno;
    }
    return ret;
   }),
   createFolder: (function(parent, name, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(canRead, canWrite);
    return FS.mkdir(path, mode);
   }),
   createPath: (function(parent, path, canRead, canWrite) {
    parent = typeof parent === "string" ? parent : FS.getPath(parent);
    var parts = path.split("/").reverse();
    while (parts.length) {
     var part = parts.pop();
     if (!part) continue;
     var current = PATH.join2(parent, part);
     try {
      FS.mkdir(current);
     } catch (e) {}
     parent = current;
    }
    return current;
   }),
   createFile: (function(parent, name, properties, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(canRead, canWrite);
    return FS.create(path, mode);
   }),
   createDataFile: (function(parent, name, data, canRead, canWrite, canOwn) {
    var path = name ? PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name) : parent;
    var mode = FS.getMode(canRead, canWrite);
    var node = FS.create(path, mode);
    if (data) {
     if (typeof data === "string") {
      var arr = new Array(data.length);
      for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
      data = arr;
     }
     FS.chmod(node, mode | 146);
     var stream = FS.open(node, "w");
     FS.write(stream, data, 0, data.length, 0, canOwn);
     FS.close(stream);
     FS.chmod(node, mode);
    }
    return node;
   }),
   createDevice: (function(parent, name, input, output) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(!!input, !!output);
    if (!FS.createDevice.major) FS.createDevice.major = 64;
    var dev = FS.makedev(FS.createDevice.major++, 0);
    FS.registerDevice(dev, {
     open: (function(stream) {
      stream.seekable = false;
     }),
     close: (function(stream) {
      if (output && output.buffer && output.buffer.length) {
       output(10);
      }
     }),
     read: (function(stream, buffer, offset, length, pos) {
      var bytesRead = 0;
      for (var i = 0; i < length; i++) {
       var result;
       try {
        result = input();
       } catch (e) {
        throw new FS.ErrnoError(ERRNO_CODES.EIO);
       }
       if (result === undefined && bytesRead === 0) {
        throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
       }
       if (result === null || result === undefined) break;
       bytesRead++;
       buffer[offset + i] = result;
      }
      if (bytesRead) {
       stream.node.timestamp = Date.now();
      }
      return bytesRead;
     }),
     write: (function(stream, buffer, offset, length, pos) {
      for (var i = 0; i < length; i++) {
       try {
        output(buffer[offset + i]);
       } catch (e) {
        throw new FS.ErrnoError(ERRNO_CODES.EIO);
       }
      }
      if (length) {
       stream.node.timestamp = Date.now();
      }
      return i;
     })
    });
    return FS.mkdev(path, mode, dev);
   }),
   createLink: (function(parent, name, target, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    return FS.symlink(target, path);
   }),
   forceLoadFile: (function(obj) {
    if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
    var success = true;
    if (typeof XMLHttpRequest !== "undefined") {
     throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
    } else if (Module["read"]) {
     try {
      obj.contents = intArrayFromString(Module["read"](obj.url), true);
      obj.usedBytes = obj.contents.length;
     } catch (e) {
      success = false;
     }
    } else {
     throw new Error("Cannot load without read() or XMLHttpRequest.");
    }
    if (!success) ___setErrNo(ERRNO_CODES.EIO);
    return success;
   }),
   createLazyFile: (function(parent, name, url, canRead, canWrite) {
    function LazyUint8Array() {
     this.lengthKnown = false;
     this.chunks = [];
    }
    LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) {
     if (idx > this.length - 1 || idx < 0) {
      return undefined;
     }
     var chunkOffset = idx % this.chunkSize;
     var chunkNum = idx / this.chunkSize | 0;
     return this.getter(chunkNum)[chunkOffset];
    };
    LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
     this.getter = getter;
    };
    LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
     var xhr = new XMLHttpRequest;
     xhr.open("HEAD", url, false);
     xhr.send(null);
     if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
     var datalength = Number(xhr.getResponseHeader("Content-length"));
     var header;
     var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
     var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
     var chunkSize = 1024 * 1024;
     if (!hasByteServing) chunkSize = datalength;
     var doXHR = (function(from, to) {
      if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
      if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
      var xhr = new XMLHttpRequest;
      xhr.open("GET", url, false);
      if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
      if (typeof Uint8Array != "undefined") xhr.responseType = "arraybuffer";
      if (xhr.overrideMimeType) {
       xhr.overrideMimeType("text/plain; charset=x-user-defined");
      }
      xhr.send(null);
      if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
      if (xhr.response !== undefined) {
       return new Uint8Array(xhr.response || []);
      } else {
       return intArrayFromString(xhr.responseText || "", true);
      }
     });
     var lazyArray = this;
     lazyArray.setDataGetter((function(chunkNum) {
      var start = chunkNum * chunkSize;
      var end = (chunkNum + 1) * chunkSize - 1;
      end = Math.min(end, datalength - 1);
      if (typeof lazyArray.chunks[chunkNum] === "undefined") {
       lazyArray.chunks[chunkNum] = doXHR(start, end);
      }
      if (typeof lazyArray.chunks[chunkNum] === "undefined") throw new Error("doXHR failed!");
      return lazyArray.chunks[chunkNum];
     }));
     if (usesGzip || !datalength) {
      chunkSize = datalength = 1;
      datalength = this.getter(0).length;
      chunkSize = datalength;
      console.log("LazyFiles on gzip forces download of the whole file when length is accessed");
     }
     this._length = datalength;
     this._chunkSize = chunkSize;
     this.lengthKnown = true;
    };
    if (typeof XMLHttpRequest !== "undefined") {
     if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
     var lazyArray = new LazyUint8Array;
     Object.defineProperties(lazyArray, {
      length: {
       get: (function() {
        if (!this.lengthKnown) {
         this.cacheLength();
        }
        return this._length;
       })
      },
      chunkSize: {
       get: (function() {
        if (!this.lengthKnown) {
         this.cacheLength();
        }
        return this._chunkSize;
       })
      }
     });
     var properties = {
      isDevice: false,
      contents: lazyArray
     };
    } else {
     var properties = {
      isDevice: false,
      url: url
     };
    }
    var node = FS.createFile(parent, name, properties, canRead, canWrite);
    if (properties.contents) {
     node.contents = properties.contents;
    } else if (properties.url) {
     node.contents = null;
     node.url = properties.url;
    }
    Object.defineProperties(node, {
     usedBytes: {
      get: (function() {
       return this.contents.length;
      })
     }
    });
    var stream_ops = {};
    var keys = Object.keys(node.stream_ops);
    keys.forEach((function(key) {
     var fn = node.stream_ops[key];
     stream_ops[key] = function forceLoadLazyFile() {
      if (!FS.forceLoadFile(node)) {
       throw new FS.ErrnoError(ERRNO_CODES.EIO);
      }
      return fn.apply(null, arguments);
     };
    }));
    stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
     if (!FS.forceLoadFile(node)) {
      throw new FS.ErrnoError(ERRNO_CODES.EIO);
     }
     var contents = stream.node.contents;
     if (position >= contents.length) return 0;
     var size = Math.min(contents.length - position, length);
     assert(size >= 0);
     if (contents.slice) {
      for (var i = 0; i < size; i++) {
       buffer[offset + i] = contents[position + i];
      }
     } else {
      for (var i = 0; i < size; i++) {
       buffer[offset + i] = contents.get(position + i);
      }
     }
     return size;
    };
    node.stream_ops = stream_ops;
    return node;
   }),
   createPreloadedFile: (function(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) {
    Browser.init();
    var fullname = name ? PATH.resolve(PATH.join2(parent, name)) : parent;
    function processData(byteArray) {
     function finish(byteArray) {
      if (preFinish) preFinish();
      if (!dontCreateFile) {
       FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
      }
      if (onload) onload();
      removeRunDependency();
     }
     var handled = false;
     Module["preloadPlugins"].forEach((function(plugin) {
      if (handled) return;
      if (plugin["canHandle"](fullname)) {
       plugin["handle"](byteArray, fullname, finish, (function() {
        if (onerror) onerror();
        removeRunDependency();
       }));
       handled = true;
      }
     }));
     if (!handled) finish(byteArray);
    }
    addRunDependency();
    if (typeof url == "string") {
     Browser.asyncLoad(url, (function(byteArray) {
      processData(byteArray);
     }), onerror);
    } else {
     processData(url);
    }
   }),
   indexedDB: (function() {
    return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
   }),
   DB_NAME: (function() {
    return "EM_FS_" + window.location.pathname;
   }),
   DB_VERSION: 20,
   DB_STORE_NAME: "FILE_DATA",
   saveFilesToDB: (function(paths, onload, onerror) {
    onload = onload || (function() {});
    onerror = onerror || (function() {});
    var indexedDB = FS.indexedDB();
    try {
     var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
    } catch (e) {
     return onerror(e);
    }
    openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
     console.log("creating db");
     var db = openRequest.result;
     db.createObjectStore(FS.DB_STORE_NAME);
    };
    openRequest.onsuccess = function openRequest_onsuccess() {
     var db = openRequest.result;
     var transaction = db.transaction([ FS.DB_STORE_NAME ], "readwrite");
     var files = transaction.objectStore(FS.DB_STORE_NAME);
     var ok = 0, fail = 0, total = paths.length;
     function finish() {
      if (fail == 0) onload(); else onerror();
     }
     paths.forEach((function(path) {
      var putRequest = files.put(FS.analyzePath(path).object.contents, path);
      putRequest.onsuccess = function putRequest_onsuccess() {
       ok++;
       if (ok + fail == total) finish();
      };
      putRequest.onerror = function putRequest_onerror() {
       fail++;
       if (ok + fail == total) finish();
      };
     }));
     transaction.onerror = onerror;
    };
    openRequest.onerror = onerror;
   }),
   loadFilesFromDB: (function(paths, onload, onerror) {
    onload = onload || (function() {});
    onerror = onerror || (function() {});
    var indexedDB = FS.indexedDB();
    try {
     var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
    } catch (e) {
     return onerror(e);
    }
    openRequest.onupgradeneeded = onerror;
    openRequest.onsuccess = function openRequest_onsuccess() {
     var db = openRequest.result;
     try {
      var transaction = db.transaction([ FS.DB_STORE_NAME ], "readonly");
     } catch (e) {
      onerror(e);
      return;
     }
     var files = transaction.objectStore(FS.DB_STORE_NAME);
     var ok = 0, fail = 0, total = paths.length;
     function finish() {
      if (fail == 0) onload(); else onerror();
     }
     paths.forEach((function(path) {
      var getRequest = files.get(path);
      getRequest.onsuccess = function getRequest_onsuccess() {
       if (FS.analyzePath(path).exists) {
        FS.unlink(path);
       }
       FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
       ok++;
       if (ok + fail == total) finish();
      };
      getRequest.onerror = function getRequest_onerror() {
       fail++;
       if (ok + fail == total) finish();
      };
     }));
     transaction.onerror = onerror;
    };
    openRequest.onerror = onerror;
   })
  };
  var SYSCALLS = {
   DEFAULT_POLLMASK: 5,
   mappings: {},
   umask: 511,
   calculateAt: (function(dirfd, path) {
    if (path[0] !== "/") {
     var dir;
     if (dirfd === -100) {
      dir = FS.cwd();
     } else {
      var dirstream = FS.getStream(dirfd);
      if (!dirstream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
      dir = dirstream.path;
     }
     path = PATH.join2(dir, path);
    }
    return path;
   }),
   doStat: (function(func, path, buf) {
    try {
     var stat = func(path);
    } catch (e) {
     if (e && e.node && PATH.normalize(path) !== PATH.normalize(FS.getPath(e.node))) {
      return -ERRNO_CODES.ENOTDIR;
     }
     throw e;
    }
    HEAP32[buf >> 2] = stat.dev;
    HEAP32[buf + 4 >> 2] = 0;
    HEAP32[buf + 8 >> 2] = stat.ino;
    HEAP32[buf + 12 >> 2] = stat.mode;
    HEAP32[buf + 16 >> 2] = stat.nlink;
    HEAP32[buf + 20 >> 2] = stat.uid;
    HEAP32[buf + 24 >> 2] = stat.gid;
    HEAP32[buf + 28 >> 2] = stat.rdev;
    HEAP32[buf + 32 >> 2] = 0;
    HEAP32[buf + 36 >> 2] = stat.size;
    HEAP32[buf + 40 >> 2] = 4096;
    HEAP32[buf + 44 >> 2] = stat.blocks;
    HEAP32[buf + 48 >> 2] = stat.atime.getTime() / 1e3 | 0;
    HEAP32[buf + 52 >> 2] = 0;
    HEAP32[buf + 56 >> 2] = stat.mtime.getTime() / 1e3 | 0;
    HEAP32[buf + 60 >> 2] = 0;
    HEAP32[buf + 64 >> 2] = stat.ctime.getTime() / 1e3 | 0;
    HEAP32[buf + 68 >> 2] = 0;
    HEAP32[buf + 72 >> 2] = stat.ino;
    return 0;
   }),
   doMsync: (function(addr, stream, len, flags) {
    var buffer = new Uint8Array(HEAPU8.subarray(addr, addr + len));
    FS.msync(stream, buffer, 0, len, flags);
   }),
   doMkdir: (function(path, mode) {
    path = PATH.normalize(path);
    if (path[path.length - 1] === "/") path = path.substr(0, path.length - 1);
    FS.mkdir(path, mode, 0);
    return 0;
   }),
   doMknod: (function(path, mode, dev) {
    switch (mode & 61440) {
    case 32768:
    case 8192:
    case 24576:
    case 4096:
    case 49152:
     break;
    default:
     return -ERRNO_CODES.EINVAL;
    }
    FS.mknod(path, mode, dev);
    return 0;
   }),
   doReadlink: (function(path, buf, bufsize) {
    if (bufsize <= 0) return -ERRNO_CODES.EINVAL;
    var ret = FS.readlink(path);
    var len = Math.min(bufsize, lengthBytesUTF8(ret));
    var endChar = HEAP8[buf + len];
    stringToUTF8(ret, buf, bufsize + 1);
    HEAP8[buf + len] = endChar;
    return len;
   }),
   doAccess: (function(path, amode) {
    if (amode & ~7) {
     return -ERRNO_CODES.EINVAL;
    }
    var node;
    var lookup = FS.lookupPath(path, {
     follow: true
    });
    node = lookup.node;
    var perms = "";
    if (amode & 4) perms += "r";
    if (amode & 2) perms += "w";
    if (amode & 1) perms += "x";
    if (perms && FS.nodePermissions(node, perms)) {
     return -ERRNO_CODES.EACCES;
    }
    return 0;
   }),
   doDup: (function(path, flags, suggestFD) {
    var suggest = FS.getStream(suggestFD);
    if (suggest) FS.close(suggest);
    return FS.open(path, flags, 0, suggestFD, suggestFD).fd;
   }),
   doReadv: (function(stream, iov, iovcnt, offset) {
    var ret = 0;
    for (var i = 0; i < iovcnt; i++) {
     var ptr = HEAP32[iov + i * 8 >> 2];
     var len = HEAP32[iov + (i * 8 + 4) >> 2];
     var curr = FS.read(stream, HEAP8, ptr, len, offset);
     if (curr < 0) return -1;
     ret += curr;
     if (curr < len) break;
    }
    return ret;
   }),
   doWritev: (function(stream, iov, iovcnt, offset) {
    var ret = 0;
    for (var i = 0; i < iovcnt; i++) {
     var ptr = HEAP32[iov + i * 8 >> 2];
     var len = HEAP32[iov + (i * 8 + 4) >> 2];
     var curr = FS.write(stream, HEAP8, ptr, len, offset);
     if (curr < 0) return -1;
     ret += curr;
    }
    return ret;
   }),
   varargs: 0,
   get: (function(varargs) {
    SYSCALLS.varargs += 4;
    var ret = HEAP32[SYSCALLS.varargs - 4 >> 2];
    return ret;
   }),
   getStr: (function() {
    var ret = Pointer_stringify(SYSCALLS.get());
    return ret;
   }),
   getStreamFromFD: (function() {
    var stream = FS.getStream(SYSCALLS.get());
    if (!stream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    return stream;
   }),
   getSocketFromFD: (function() {
    var socket = SOCKFS.getSocket(SYSCALLS.get());
    if (!socket) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    return socket;
   }),
   getSocketAddress: (function(allowNull) {
    var addrp = SYSCALLS.get(), addrlen = SYSCALLS.get();
    if (allowNull && addrp === 0) return null;
    var info = __read_sockaddr(addrp, addrlen);
    if (info.errno) throw new FS.ErrnoError(info.errno);
    info.addr = DNS.lookup_addr(info.addr) || info.addr;
    return info;
   }),
   get64: (function() {
    var low = SYSCALLS.get(), high = SYSCALLS.get();
    if (low >= 0) assert(high === 0); else assert(high === -1);
    return low;
   }),
   getZero: (function() {
    assert(SYSCALLS.get() === 0);
   })
  };
  function ___syscall5(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var pathname = SYSCALLS.getStr(), flags = SYSCALLS.get(), mode = SYSCALLS.get();
    var stream = FS.open(pathname, flags, mode);
    return stream.fd;
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  function ___lock() {}
  function ___unlock() {}
  function ___syscall6(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD();
    FS.close(stream);
    return 0;
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  var cttz_i8 = allocate([ 8, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 6, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 7, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 6, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0 ], "i8", ALLOC_STATIC);
  Module["_llvm_cttz_i32"] = _llvm_cttz_i32;
  Module["___udivmoddi4"] = ___udivmoddi4;
  Module["___udivdi3"] = ___udivdi3;
  Module["___muldsi3"] = ___muldsi3;
  Module["___muldi3"] = ___muldi3;
  Module["_sbrk"] = _sbrk;
  function _emscripten_memcpy_big(dest, src, num) {
   HEAPU8.set(HEAPU8.subarray(src, src + num), dest);
   return dest;
  }
  Module["_memcpy"] = _memcpy;
  Module["_memmove"] = _memmove;
  Module["___uremdi3"] = ___uremdi3;
  function __exit(status) {
   Module["exit"](status);
  }
  function _exit(status) {
   __exit(status);
  }
  Module["_pthread_self"] = _pthread_self;
  function ___syscall140(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD(), offset_high = SYSCALLS.get(), offset_low = SYSCALLS.get(), result = SYSCALLS.get(), whence = SYSCALLS.get();
    var offset = offset_low;
    assert(offset_high === 0);
    FS.llseek(stream, offset, whence);
    HEAP32[result >> 2] = stream.position;
    if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
    return 0;
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  function ___syscall146(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD(), iov = SYSCALLS.get(), iovcnt = SYSCALLS.get();
    return SYSCALLS.doWritev(stream, iov, iovcnt);
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  function ___syscall54(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD(), op = SYSCALLS.get();
    switch (op) {
    case 21505:
     {
      if (!stream.tty) return -ERRNO_CODES.ENOTTY;
      return 0;
     }
    case 21506:
     {
      if (!stream.tty) return -ERRNO_CODES.ENOTTY;
      return 0;
     }
    case 21519:
     {
      if (!stream.tty) return -ERRNO_CODES.ENOTTY;
      var argp = SYSCALLS.get();
      HEAP32[argp >> 2] = 0;
      return 0;
     }
    case 21520:
     {
      if (!stream.tty) return -ERRNO_CODES.ENOTTY;
      return -ERRNO_CODES.EINVAL;
     }
    case 21531:
     {
      var argp = SYSCALLS.get();
      return FS.ioctl(stream, op, argp);
     }
    default:
     abort("bad ioctl syscall " + op);
    }
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  function ___syscall221(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD(), cmd = SYSCALLS.get();
    switch (cmd) {
    case 0:
     {
      var arg = SYSCALLS.get();
      if (arg < 0) {
       return -ERRNO_CODES.EINVAL;
      }
      var newStream;
      newStream = FS.open(stream.path, stream.flags, 0, arg);
      return newStream.fd;
     }
    case 1:
    case 2:
     return 0;
    case 3:
     return stream.flags;
    case 4:
     {
      var arg = SYSCALLS.get();
      stream.flags |= arg;
      return 0;
     }
    case 12:
    case 12:
     {
      var arg = SYSCALLS.get();
      var offset = 0;
      HEAP16[arg + offset >> 1] = 2;
      return 0;
     }
    case 13:
    case 14:
    case 13:
    case 14:
     return 0;
    case 16:
    case 8:
     return -ERRNO_CODES.EINVAL;
    case 9:
     ___setErrNo(ERRNO_CODES.EINVAL);
     return -1;
    default:
     {
      return -ERRNO_CODES.EINVAL;
     }
    }
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  function ___syscall145(which, varargs) {
   SYSCALLS.varargs = varargs;
   try {
    var stream = SYSCALLS.getStreamFromFD(), iov = SYSCALLS.get(), iovcnt = SYSCALLS.get();
    return SYSCALLS.doReadv(stream, iov, iovcnt);
   } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
   }
  }
  FS.staticInit();
  __ATINIT__.unshift((function() {
   if (!Module["noFSInit"] && !FS.init.initialized) FS.init();
  }));
  __ATMAIN__.push((function() {
   FS.ignorePermissions = false;
  }));
  __ATEXIT__.push((function() {
   FS.quit();
  }));
  Module["FS_createFolder"] = FS.createFolder;
  Module["FS_createPath"] = FS.createPath;
  Module["FS_createDataFile"] = FS.createDataFile;
  Module["FS_createPreloadedFile"] = FS.createPreloadedFile;
  Module["FS_createLazyFile"] = FS.createLazyFile;
  Module["FS_createLink"] = FS.createLink;
  Module["FS_createDevice"] = FS.createDevice;
  Module["FS_unlink"] = FS.unlink;
  __ATINIT__.unshift((function() {
   TTY.init();
  }));
  __ATEXIT__.push((function() {
   TTY.shutdown();
  }));
  if (ENVIRONMENT_IS_NODE) {
   var fs$1 = fs;
   var NODEJS_PATH = path$1;
   NODEFS.staticInit();
  }
  DYNAMICTOP_PTR = allocate(1, "i32", ALLOC_STATIC);
  STACK_BASE = STACKTOP = Runtime.alignMemory(STATICTOP);
  STACK_MAX = STACK_BASE + TOTAL_STACK;
  DYNAMIC_BASE = Runtime.alignMemory(STACK_MAX);
  HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
  staticSealed = true;
  function invoke_iiii(index, a1, a2, a3) {
   try {
    return Module["dynCall_iiii"](index, a1, a2, a3);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  function invoke_vi(index, a1) {
   try {
    Module["dynCall_vi"](index, a1);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  function invoke_vii(index, a1, a2) {
   try {
    Module["dynCall_vii"](index, a1, a2);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  function invoke_ii(index, a1) {
   try {
    return Module["dynCall_ii"](index, a1);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  function invoke_iii(index, a1, a2) {
   try {
    return Module["dynCall_iii"](index, a1, a2);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  function invoke_viiii(index, a1, a2, a3, a4) {
   try {
    Module["dynCall_viiii"](index, a1, a2, a3, a4);
   } catch (e) {
    if (typeof e !== "number" && e !== "longjmp") throw e;
    asm["setThrew"](1, 0);
   }
  }
  Module.asmGlobalArg = {
   "Math": Math,
   "Int8Array": Int8Array,
   "Int16Array": Int16Array,
   "Int32Array": Int32Array,
   "Uint8Array": Uint8Array,
   "Uint16Array": Uint16Array,
   "Uint32Array": Uint32Array,
   "Float32Array": Float32Array,
   "Float64Array": Float64Array,
   "NaN": NaN,
   "Infinity": Infinity
  };
  Module.asmLibraryArg = {
   "abort": abort,
   "assert": assert,
   "enlargeMemory": enlargeMemory,
   "getTotalMemory": getTotalMemory,
   "abortOnCannotGrowMemory": abortOnCannotGrowMemory,
   "invoke_iiii": invoke_iiii,
   "invoke_vi": invoke_vi,
   "invoke_vii": invoke_vii,
   "invoke_ii": invoke_ii,
   "invoke_iii": invoke_iii,
   "invoke_viiii": invoke_viiii,
   "_pthread_cleanup_pop": _pthread_cleanup_pop,
   "___syscall221": ___syscall221,
   "___lock": ___lock,
   "_abort": _abort,
   "___setErrNo": ___setErrNo,
   "___syscall6": ___syscall6,
   "___syscall140": ___syscall140,
   "___syscall5": ___syscall5,
   "_emscripten_memcpy_big": _emscripten_memcpy_big,
   "___syscall54": ___syscall54,
   "___unlock": ___unlock,
   "_exit": _exit,
   "_pthread_cleanup_push": _pthread_cleanup_push,
   "__exit": __exit,
   "___syscall145": ___syscall145,
   "___syscall146": ___syscall146,
   "STACKTOP": STACKTOP,
   "STACK_MAX": STACK_MAX,
   "DYNAMICTOP_PTR": DYNAMICTOP_PTR,
   "tempDoublePtr": tempDoublePtr,
   "ABORT": ABORT,
   "cttz_i8": cttz_i8
  };
  // EMSCRIPTEN_START_ASM

  var asm = (function(global,env,buffer) {

   "use asm";
   var a = new global.Int8Array(buffer);
   var b = new global.Int16Array(buffer);
   var c = new global.Int32Array(buffer);
   var d = new global.Uint8Array(buffer);
   var e = new global.Uint16Array(buffer);
   var f = new global.Uint32Array(buffer);
   var g = new global.Float32Array(buffer);
   var h = new global.Float64Array(buffer);
   var i = env.STACKTOP | 0;
   var j = env.STACK_MAX | 0;
   var k = env.DYNAMICTOP_PTR | 0;
   var l = env.tempDoublePtr | 0;
   var m = env.ABORT | 0;
   var n = env.cttz_i8 | 0;
   var o = 0;
   var p = 0;
   var q = 0;
   var r = 0;
   var s = global.NaN, t = global.Infinity;
   var u = 0, v = 0, w = 0, x = 0, y = 0.0, z = 0, A = 0, B = 0, C = 0.0;
   var D = 0;
   var E = global.Math.floor;
   var F = global.Math.abs;
   var G = global.Math.sqrt;
   var H = global.Math.pow;
   var I = global.Math.cos;
   var J = global.Math.sin;
   var K = global.Math.tan;
   var L = global.Math.acos;
   var M = global.Math.asin;
   var N = global.Math.atan;
   var O = global.Math.atan2;
   var P = global.Math.exp;
   var Q = global.Math.log;
   var R = global.Math.ceil;
   var S = global.Math.imul;
   var T = global.Math.min;
   var U = global.Math.max;
   var V = global.Math.clz32;
   var W = env.abort;
   var X = env.assert;
   var Y = env.enlargeMemory;
   var Z = env.getTotalMemory;
   var _ = env.abortOnCannotGrowMemory;
   var $ = env.invoke_iiii;
   var aa = env.invoke_vi;
   var ba = env.invoke_vii;
   var ca = env.invoke_ii;
   var da = env.invoke_iii;
   var ea = env.invoke_viiii;
   var fa = env._pthread_cleanup_pop;
   var ga = env.___syscall221;
   var ha = env.___lock;
   var ia = env._abort;
   var ja = env.___setErrNo;
   var ka = env.___syscall6;
   var la = env.___syscall140;
   var ma = env.___syscall5;
   var na = env._emscripten_memcpy_big;
   var oa = env.___syscall54;
   var pa = env.___unlock;
   var qa = env._exit;
   var ra = env._pthread_cleanup_push;
   var sa = env.__exit;
   var ta = env.___syscall145;
   var ua = env.___syscall146;
   var va = 0.0;
   
  // EMSCRIPTEN_START_FUNCS
  function ze(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0, C = 0, D = 0;
   D = i;
   i = i + 16 | 0;
   p = D;
   do if (a >>> 0 < 245) {
    o = a >>> 0 < 11 ? 16 : a + 11 & -8;
    a = o >>> 3;
    t = c[19106] | 0;
    b = t >>> a;
    if (b & 3 | 0) {
     b = (b & 1 ^ 1) + a | 0;
     d = 76464 + (b << 1 << 2) | 0;
     e = d + 8 | 0;
     f = c[e >> 2] | 0;
     g = f + 8 | 0;
     h = c[g >> 2] | 0;
     do if ((d | 0) == (h | 0)) c[19106] = t & ~(1 << b); else {
      if (h >>> 0 < (c[19110] | 0) >>> 0) ia();
      a = h + 12 | 0;
      if ((c[a >> 2] | 0) == (f | 0)) {
       c[a >> 2] = d;
       c[e >> 2] = h;
       break;
      } else ia();
     } while (0);
     C = b << 3;
     c[f + 4 >> 2] = C | 3;
     C = f + C + 4 | 0;
     c[C >> 2] = c[C >> 2] | 1;
     C = g;
     i = D;
     return C | 0;
    }
    s = c[19108] | 0;
    if (o >>> 0 > s >>> 0) {
     if (b | 0) {
      j = 2 << a;
      b = b << a & (j | 0 - j);
      b = (b & 0 - b) + -1 | 0;
      j = b >>> 12 & 16;
      b = b >>> j;
      e = b >>> 5 & 8;
      b = b >>> e;
      g = b >>> 2 & 4;
      b = b >>> g;
      d = b >>> 1 & 2;
      b = b >>> d;
      a = b >>> 1 & 1;
      a = (e | j | g | d | a) + (b >>> a) | 0;
      b = 76464 + (a << 1 << 2) | 0;
      d = b + 8 | 0;
      g = c[d >> 2] | 0;
      j = g + 8 | 0;
      e = c[j >> 2] | 0;
      do if ((b | 0) == (e | 0)) {
       k = t & ~(1 << a);
       c[19106] = k;
      } else {
       if (e >>> 0 < (c[19110] | 0) >>> 0) ia();
       f = e + 12 | 0;
       if ((c[f >> 2] | 0) == (g | 0)) {
        c[f >> 2] = b;
        c[d >> 2] = e;
        k = t;
        break;
       } else ia();
      } while (0);
      h = (a << 3) - o | 0;
      c[g + 4 >> 2] = o | 3;
      e = g + o | 0;
      c[e + 4 >> 2] = h | 1;
      c[e + h >> 2] = h;
      if (s | 0) {
       f = c[19111] | 0;
       a = s >>> 3;
       d = 76464 + (a << 1 << 2) | 0;
       a = 1 << a;
       if (!(k & a)) {
        c[19106] = k | a;
        l = d;
        m = d + 8 | 0;
       } else {
        a = d + 8 | 0;
        b = c[a >> 2] | 0;
        if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
         l = b;
         m = a;
        }
       }
       c[m >> 2] = f;
       c[l + 12 >> 2] = f;
       c[f + 8 >> 2] = l;
       c[f + 12 >> 2] = d;
      }
      c[19108] = h;
      c[19111] = e;
      C = j;
      i = D;
      return C | 0;
     }
     j = c[19107] | 0;
     if (j) {
      b = (j & 0 - j) + -1 | 0;
      B = b >>> 12 & 16;
      b = b >>> B;
      A = b >>> 5 & 8;
      b = b >>> A;
      C = b >>> 2 & 4;
      b = b >>> C;
      k = b >>> 1 & 2;
      b = b >>> k;
      l = b >>> 1 & 1;
      l = c[76728 + ((A | B | C | k | l) + (b >>> l) << 2) >> 2] | 0;
      b = l;
      k = l;
      l = (c[l + 4 >> 2] & -8) - o | 0;
      while (1) {
       a = c[b + 16 >> 2] | 0;
       if (!a) {
        a = c[b + 20 >> 2] | 0;
        if (!a) break;
       }
       C = (c[a + 4 >> 2] & -8) - o | 0;
       B = C >>> 0 < l >>> 0;
       b = a;
       k = B ? a : k;
       l = B ? C : l;
      }
      f = c[19110] | 0;
      if (k >>> 0 < f >>> 0) ia();
      h = k + o | 0;
      if (k >>> 0 >= h >>> 0) ia();
      g = c[k + 24 >> 2] | 0;
      d = c[k + 12 >> 2] | 0;
      do if ((d | 0) == (k | 0)) {
       b = k + 20 | 0;
       a = c[b >> 2] | 0;
       if (!a) {
        b = k + 16 | 0;
        a = c[b >> 2] | 0;
        if (!a) {
         n = 0;
         break;
        }
       }
       while (1) {
        d = a + 20 | 0;
        e = c[d >> 2] | 0;
        if (e | 0) {
         a = e;
         b = d;
         continue;
        }
        d = a + 16 | 0;
        e = c[d >> 2] | 0;
        if (!e) break; else {
         a = e;
         b = d;
        }
       }
       if (b >>> 0 < f >>> 0) ia(); else {
        c[b >> 2] = 0;
        n = a;
        break;
       }
      } else {
       e = c[k + 8 >> 2] | 0;
       if (e >>> 0 < f >>> 0) ia();
       a = e + 12 | 0;
       if ((c[a >> 2] | 0) != (k | 0)) ia();
       b = d + 8 | 0;
       if ((c[b >> 2] | 0) == (k | 0)) {
        c[a >> 2] = d;
        c[b >> 2] = e;
        n = d;
        break;
       } else ia();
      } while (0);
      do if (g | 0) {
       a = c[k + 28 >> 2] | 0;
       b = 76728 + (a << 2) | 0;
       if ((k | 0) == (c[b >> 2] | 0)) {
        c[b >> 2] = n;
        if (!n) {
         c[19107] = j & ~(1 << a);
         break;
        }
       } else {
        if (g >>> 0 < (c[19110] | 0) >>> 0) ia();
        a = g + 16 | 0;
        if ((c[a >> 2] | 0) == (k | 0)) c[a >> 2] = n; else c[g + 20 >> 2] = n;
        if (!n) break;
       }
       b = c[19110] | 0;
       if (n >>> 0 < b >>> 0) ia();
       c[n + 24 >> 2] = g;
       a = c[k + 16 >> 2] | 0;
       do if (a | 0) if (a >>> 0 < b >>> 0) ia(); else {
        c[n + 16 >> 2] = a;
        c[a + 24 >> 2] = n;
        break;
       } while (0);
       a = c[k + 20 >> 2] | 0;
       if (a | 0) if (a >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
        c[n + 20 >> 2] = a;
        c[a + 24 >> 2] = n;
        break;
       }
      } while (0);
      if (l >>> 0 < 16) {
       C = l + o | 0;
       c[k + 4 >> 2] = C | 3;
       C = k + C + 4 | 0;
       c[C >> 2] = c[C >> 2] | 1;
      } else {
       c[k + 4 >> 2] = o | 3;
       c[h + 4 >> 2] = l | 1;
       c[h + l >> 2] = l;
       if (s | 0) {
        e = c[19111] | 0;
        a = s >>> 3;
        d = 76464 + (a << 1 << 2) | 0;
        a = 1 << a;
        if (!(t & a)) {
         c[19106] = t | a;
         q = d;
         r = d + 8 | 0;
        } else {
         a = d + 8 | 0;
         b = c[a >> 2] | 0;
         if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
          q = b;
          r = a;
         }
        }
        c[r >> 2] = e;
        c[q + 12 >> 2] = e;
        c[e + 8 >> 2] = q;
        c[e + 12 >> 2] = d;
       }
       c[19108] = l;
       c[19111] = h;
      }
      C = k + 8 | 0;
      i = D;
      return C | 0;
     }
    }
   } else if (a >>> 0 > 4294967231) o = -1; else {
    a = a + 11 | 0;
    o = a & -8;
    l = c[19107] | 0;
    if (l) {
     d = 0 - o | 0;
     a = a >>> 8;
     if (!a) h = 0; else if (o >>> 0 > 16777215) h = 31; else {
      r = (a + 1048320 | 0) >>> 16 & 8;
      w = a << r;
      q = (w + 520192 | 0) >>> 16 & 4;
      w = w << q;
      h = (w + 245760 | 0) >>> 16 & 2;
      h = 14 - (q | r | h) + (w << h >>> 15) | 0;
      h = o >>> (h + 7 | 0) & 1 | h << 1;
     }
     a = c[76728 + (h << 2) >> 2] | 0;
     a : do if (!a) {
      b = 0;
      e = 0;
      w = 86;
     } else {
      e = 0;
      g = a;
      f = o << ((h | 0) == 31 ? 0 : 25 - (h >>> 1) | 0);
      b = 0;
      while (1) {
       a = (c[g + 4 >> 2] & -8) - o | 0;
       if (a >>> 0 < d >>> 0) if (!a) {
        a = g;
        d = 0;
        b = g;
        w = 90;
        break a;
       } else {
        e = g;
        d = a;
       }
       a = c[g + 20 >> 2] | 0;
       g = c[g + 16 + (f >>> 31 << 2) >> 2] | 0;
       b = (a | 0) == 0 | (a | 0) == (g | 0) ? b : a;
       a = (g | 0) == 0;
       if (a) {
        w = 86;
        break;
       } else f = f << (a & 1 ^ 1);
      }
     } while (0);
     if ((w | 0) == 86) {
      if ((b | 0) == 0 & (e | 0) == 0) {
       a = 2 << h;
       a = l & (a | 0 - a);
       if (!a) break;
       r = (a & 0 - a) + -1 | 0;
       m = r >>> 12 & 16;
       r = r >>> m;
       k = r >>> 5 & 8;
       r = r >>> k;
       n = r >>> 2 & 4;
       r = r >>> n;
       q = r >>> 1 & 2;
       r = r >>> q;
       b = r >>> 1 & 1;
       b = c[76728 + ((k | m | n | q | b) + (r >>> b) << 2) >> 2] | 0;
      }
      if (!b) {
       k = e;
       h = d;
      } else {
       a = e;
       w = 90;
      }
     }
     if ((w | 0) == 90) while (1) {
      w = 0;
      r = (c[b + 4 >> 2] & -8) - o | 0;
      e = r >>> 0 < d >>> 0;
      d = e ? r : d;
      a = e ? b : a;
      e = c[b + 16 >> 2] | 0;
      if (e | 0) {
       b = e;
       w = 90;
       continue;
      }
      b = c[b + 20 >> 2] | 0;
      if (!b) {
       k = a;
       h = d;
       break;
      } else w = 90;
     }
     if (k) if (h >>> 0 < ((c[19108] | 0) - o | 0) >>> 0) {
      f = c[19110] | 0;
      if (k >>> 0 < f >>> 0) ia();
      j = k + o | 0;
      if (k >>> 0 >= j >>> 0) ia();
      g = c[k + 24 >> 2] | 0;
      d = c[k + 12 >> 2] | 0;
      do if ((d | 0) == (k | 0)) {
       b = k + 20 | 0;
       a = c[b >> 2] | 0;
       if (!a) {
        b = k + 16 | 0;
        a = c[b >> 2] | 0;
        if (!a) {
         s = 0;
         break;
        }
       }
       while (1) {
        d = a + 20 | 0;
        e = c[d >> 2] | 0;
        if (e | 0) {
         a = e;
         b = d;
         continue;
        }
        d = a + 16 | 0;
        e = c[d >> 2] | 0;
        if (!e) break; else {
         a = e;
         b = d;
        }
       }
       if (b >>> 0 < f >>> 0) ia(); else {
        c[b >> 2] = 0;
        s = a;
        break;
       }
      } else {
       e = c[k + 8 >> 2] | 0;
       if (e >>> 0 < f >>> 0) ia();
       a = e + 12 | 0;
       if ((c[a >> 2] | 0) != (k | 0)) ia();
       b = d + 8 | 0;
       if ((c[b >> 2] | 0) == (k | 0)) {
        c[a >> 2] = d;
        c[b >> 2] = e;
        s = d;
        break;
       } else ia();
      } while (0);
      do if (!g) t = l; else {
       a = c[k + 28 >> 2] | 0;
       b = 76728 + (a << 2) | 0;
       if ((k | 0) == (c[b >> 2] | 0)) {
        c[b >> 2] = s;
        if (!s) {
         t = l & ~(1 << a);
         c[19107] = t;
         break;
        }
       } else {
        if (g >>> 0 < (c[19110] | 0) >>> 0) ia();
        a = g + 16 | 0;
        if ((c[a >> 2] | 0) == (k | 0)) c[a >> 2] = s; else c[g + 20 >> 2] = s;
        if (!s) {
         t = l;
         break;
        }
       }
       b = c[19110] | 0;
       if (s >>> 0 < b >>> 0) ia();
       c[s + 24 >> 2] = g;
       a = c[k + 16 >> 2] | 0;
       do if (a | 0) if (a >>> 0 < b >>> 0) ia(); else {
        c[s + 16 >> 2] = a;
        c[a + 24 >> 2] = s;
        break;
       } while (0);
       a = c[k + 20 >> 2] | 0;
       if (!a) t = l; else if (a >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
        c[s + 20 >> 2] = a;
        c[a + 24 >> 2] = s;
        t = l;
        break;
       }
      } while (0);
      do if (h >>> 0 < 16) {
       C = h + o | 0;
       c[k + 4 >> 2] = C | 3;
       C = k + C + 4 | 0;
       c[C >> 2] = c[C >> 2] | 1;
      } else {
       c[k + 4 >> 2] = o | 3;
       c[j + 4 >> 2] = h | 1;
       c[j + h >> 2] = h;
       a = h >>> 3;
       if (h >>> 0 < 256) {
        d = 76464 + (a << 1 << 2) | 0;
        b = c[19106] | 0;
        a = 1 << a;
        if (!(b & a)) {
         c[19106] = b | a;
         u = d;
         v = d + 8 | 0;
        } else {
         a = d + 8 | 0;
         b = c[a >> 2] | 0;
         if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
          u = b;
          v = a;
         }
        }
        c[v >> 2] = j;
        c[u + 12 >> 2] = j;
        c[j + 8 >> 2] = u;
        c[j + 12 >> 2] = d;
        break;
       }
       a = h >>> 8;
       if (!a) a = 0; else if (h >>> 0 > 16777215) a = 31; else {
        B = (a + 1048320 | 0) >>> 16 & 8;
        C = a << B;
        A = (C + 520192 | 0) >>> 16 & 4;
        C = C << A;
        a = (C + 245760 | 0) >>> 16 & 2;
        a = 14 - (A | B | a) + (C << a >>> 15) | 0;
        a = h >>> (a + 7 | 0) & 1 | a << 1;
       }
       d = 76728 + (a << 2) | 0;
       c[j + 28 >> 2] = a;
       b = j + 16 | 0;
       c[b + 4 >> 2] = 0;
       c[b >> 2] = 0;
       b = 1 << a;
       if (!(t & b)) {
        c[19107] = t | b;
        c[d >> 2] = j;
        c[j + 24 >> 2] = d;
        c[j + 12 >> 2] = j;
        c[j + 8 >> 2] = j;
        break;
       }
       b = h << ((a | 0) == 31 ? 0 : 25 - (a >>> 1) | 0);
       e = c[d >> 2] | 0;
       while (1) {
        if ((c[e + 4 >> 2] & -8 | 0) == (h | 0)) {
         w = 148;
         break;
        }
        d = e + 16 + (b >>> 31 << 2) | 0;
        a = c[d >> 2] | 0;
        if (!a) {
         w = 145;
         break;
        } else {
         b = b << 1;
         e = a;
        }
       }
       if ((w | 0) == 145) if (d >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
        c[d >> 2] = j;
        c[j + 24 >> 2] = e;
        c[j + 12 >> 2] = j;
        c[j + 8 >> 2] = j;
        break;
       } else if ((w | 0) == 148) {
        a = e + 8 | 0;
        b = c[a >> 2] | 0;
        C = c[19110] | 0;
        if (b >>> 0 >= C >>> 0 & e >>> 0 >= C >>> 0) {
         c[b + 12 >> 2] = j;
         c[a >> 2] = j;
         c[j + 8 >> 2] = b;
         c[j + 12 >> 2] = e;
         c[j + 24 >> 2] = 0;
         break;
        } else ia();
       }
      } while (0);
      C = k + 8 | 0;
      i = D;
      return C | 0;
     }
    }
   } while (0);
   d = c[19108] | 0;
   if (d >>> 0 >= o >>> 0) {
    a = d - o | 0;
    b = c[19111] | 0;
    if (a >>> 0 > 15) {
     C = b + o | 0;
     c[19111] = C;
     c[19108] = a;
     c[C + 4 >> 2] = a | 1;
     c[C + a >> 2] = a;
     c[b + 4 >> 2] = o | 3;
    } else {
     c[19108] = 0;
     c[19111] = 0;
     c[b + 4 >> 2] = d | 3;
     C = b + d + 4 | 0;
     c[C >> 2] = c[C >> 2] | 1;
    }
    C = b + 8 | 0;
    i = D;
    return C | 0;
   }
   h = c[19109] | 0;
   if (h >>> 0 > o >>> 0) {
    A = h - o | 0;
    c[19109] = A;
    C = c[19112] | 0;
    B = C + o | 0;
    c[19112] = B;
    c[B + 4 >> 2] = A | 1;
    c[C + 4 >> 2] = o | 3;
    C = C + 8 | 0;
    i = D;
    return C | 0;
   }
   if (!(c[19224] | 0)) {
    c[19226] = 4096;
    c[19225] = 4096;
    c[19227] = -1;
    c[19228] = -1;
    c[19229] = 0;
    c[19217] = 0;
    a = p & -16 ^ 1431655768;
    c[p >> 2] = a;
    c[19224] = a;
    a = 4096;
   } else a = c[19226] | 0;
   j = o + 48 | 0;
   k = o + 47 | 0;
   g = a + k | 0;
   e = 0 - a | 0;
   l = g & e;
   if (l >>> 0 <= o >>> 0) {
    C = 0;
    i = D;
    return C | 0;
   }
   a = c[19216] | 0;
   if (a | 0) {
    u = c[19214] | 0;
    v = u + l | 0;
    if (v >>> 0 <= u >>> 0 | v >>> 0 > a >>> 0) {
     C = 0;
     i = D;
     return C | 0;
    }
   }
   b : do if (!(c[19217] & 4)) {
    b = c[19112] | 0;
    c : do if (!b) w = 172; else {
     d = 76872;
     while (1) {
      a = c[d >> 2] | 0;
      if (a >>> 0 <= b >>> 0) {
       f = d + 4 | 0;
       if ((a + (c[f >> 2] | 0) | 0) >>> 0 > b >>> 0) break;
      }
      a = c[d + 8 >> 2] | 0;
      if (!a) {
       w = 172;
       break c;
      } else d = a;
     }
     a = g - h & e;
     if (a >>> 0 < 2147483647) {
      b = Me(a | 0) | 0;
      if ((b | 0) == ((c[d >> 2] | 0) + (c[f >> 2] | 0) | 0)) {
       if ((b | 0) != (-1 | 0)) {
        h = a;
        g = b;
        w = 190;
        break b;
       }
      } else {
       e = b;
       w = 180;
      }
     }
    } while (0);
    do if ((w | 0) == 172) {
     f = Me(0) | 0;
     if ((f | 0) != (-1 | 0)) {
      a = f;
      b = c[19225] | 0;
      d = b + -1 | 0;
      a = ((d & a | 0) == 0 ? 0 : (d + a & 0 - b) - a | 0) + l | 0;
      b = c[19214] | 0;
      d = a + b | 0;
      if (a >>> 0 > o >>> 0 & a >>> 0 < 2147483647) {
       e = c[19216] | 0;
       if (e | 0) if (d >>> 0 <= b >>> 0 | d >>> 0 > e >>> 0) break;
       b = Me(a | 0) | 0;
       if ((b | 0) == (f | 0)) {
        h = a;
        g = f;
        w = 190;
        break b;
       } else {
        e = b;
        w = 180;
       }
      }
     }
    } while (0);
    d : do if ((w | 0) == 180) {
     d = 0 - a | 0;
     do if (j >>> 0 > a >>> 0 & (a >>> 0 < 2147483647 & (e | 0) != (-1 | 0))) {
      b = c[19226] | 0;
      b = k - a + b & 0 - b;
      if (b >>> 0 < 2147483647) if ((Me(b | 0) | 0) == (-1 | 0)) {
       Me(d | 0) | 0;
       break d;
      } else {
       a = b + a | 0;
       break;
      }
     } while (0);
     if ((e | 0) != (-1 | 0)) {
      h = a;
      g = e;
      w = 190;
      break b;
     }
    } while (0);
    c[19217] = c[19217] | 4;
    w = 187;
   } else w = 187; while (0);
   if ((w | 0) == 187) if (l >>> 0 < 2147483647) {
    b = Me(l | 0) | 0;
    a = Me(0) | 0;
    if (b >>> 0 < a >>> 0 & ((b | 0) != (-1 | 0) & (a | 0) != (-1 | 0))) {
     a = a - b | 0;
     if (a >>> 0 > (o + 40 | 0) >>> 0) {
      h = a;
      g = b;
      w = 190;
     }
    }
   }
   if ((w | 0) == 190) {
    a = (c[19214] | 0) + h | 0;
    c[19214] = a;
    if (a >>> 0 > (c[19215] | 0) >>> 0) c[19215] = a;
    l = c[19112] | 0;
    do if (!l) {
     C = c[19110] | 0;
     if ((C | 0) == 0 | g >>> 0 < C >>> 0) c[19110] = g;
     c[19218] = g;
     c[19219] = h;
     c[19221] = 0;
     c[19115] = c[19224];
     c[19114] = -1;
     a = 0;
     do {
      C = 76464 + (a << 1 << 2) | 0;
      c[C + 12 >> 2] = C;
      c[C + 8 >> 2] = C;
      a = a + 1 | 0;
     } while ((a | 0) != 32);
     C = g + 8 | 0;
     C = (C & 7 | 0) == 0 ? 0 : 0 - C & 7;
     B = g + C | 0;
     C = h + -40 - C | 0;
     c[19112] = B;
     c[19109] = C;
     c[B + 4 >> 2] = C | 1;
     c[B + C + 4 >> 2] = 40;
     c[19113] = c[19228];
    } else {
     a = 76872;
     do {
      b = c[a >> 2] | 0;
      d = a + 4 | 0;
      e = c[d >> 2] | 0;
      if ((g | 0) == (b + e | 0)) {
       w = 200;
       break;
      }
      a = c[a + 8 >> 2] | 0;
     } while ((a | 0) != 0);
     if ((w | 0) == 200) if (!(c[a + 12 >> 2] & 8)) if (l >>> 0 < g >>> 0 & l >>> 0 >= b >>> 0) {
      c[d >> 2] = e + h;
      C = l + 8 | 0;
      C = (C & 7 | 0) == 0 ? 0 : 0 - C & 7;
      B = l + C | 0;
      C = h - C + (c[19109] | 0) | 0;
      c[19112] = B;
      c[19109] = C;
      c[B + 4 >> 2] = C | 1;
      c[B + C + 4 >> 2] = 40;
      c[19113] = c[19228];
      break;
     }
     a = c[19110] | 0;
     if (g >>> 0 < a >>> 0) {
      c[19110] = g;
      j = g;
     } else j = a;
     b = g + h | 0;
     a = 76872;
     while (1) {
      if ((c[a >> 2] | 0) == (b | 0)) {
       w = 208;
       break;
      }
      a = c[a + 8 >> 2] | 0;
      if (!a) {
       b = 76872;
       break;
      }
     }
     if ((w | 0) == 208) if (!(c[a + 12 >> 2] & 8)) {
      c[a >> 2] = g;
      n = a + 4 | 0;
      c[n >> 2] = (c[n >> 2] | 0) + h;
      n = g + 8 | 0;
      n = g + ((n & 7 | 0) == 0 ? 0 : 0 - n & 7) | 0;
      a = b + 8 | 0;
      a = b + ((a & 7 | 0) == 0 ? 0 : 0 - a & 7) | 0;
      m = n + o | 0;
      k = a - n - o | 0;
      c[n + 4 >> 2] = o | 3;
      do if ((a | 0) == (l | 0)) {
       C = (c[19109] | 0) + k | 0;
       c[19109] = C;
       c[19112] = m;
       c[m + 4 >> 2] = C | 1;
      } else {
       if ((a | 0) == (c[19111] | 0)) {
        C = (c[19108] | 0) + k | 0;
        c[19108] = C;
        c[19111] = m;
        c[m + 4 >> 2] = C | 1;
        c[m + C >> 2] = C;
        break;
       }
       b = c[a + 4 >> 2] | 0;
       if ((b & 3 | 0) == 1) {
        h = b & -8;
        f = b >>> 3;
        e : do if (b >>> 0 < 256) {
         d = c[a + 8 >> 2] | 0;
         e = c[a + 12 >> 2] | 0;
         b = 76464 + (f << 1 << 2) | 0;
         do if ((d | 0) != (b | 0)) {
          if (d >>> 0 < j >>> 0) ia();
          if ((c[d + 12 >> 2] | 0) == (a | 0)) break;
          ia();
         } while (0);
         if ((e | 0) == (d | 0)) {
          c[19106] = c[19106] & ~(1 << f);
          break;
         }
         do if ((e | 0) == (b | 0)) x = e + 8 | 0; else {
          if (e >>> 0 < j >>> 0) ia();
          b = e + 8 | 0;
          if ((c[b >> 2] | 0) == (a | 0)) {
           x = b;
           break;
          }
          ia();
         } while (0);
         c[d + 12 >> 2] = e;
         c[x >> 2] = d;
        } else {
         g = c[a + 24 >> 2] | 0;
         e = c[a + 12 >> 2] | 0;
         do if ((e | 0) == (a | 0)) {
          e = a + 16 | 0;
          d = e + 4 | 0;
          b = c[d >> 2] | 0;
          if (!b) {
           b = c[e >> 2] | 0;
           if (!b) {
            A = 0;
            break;
           } else d = e;
          }
          while (1) {
           e = b + 20 | 0;
           f = c[e >> 2] | 0;
           if (f | 0) {
            b = f;
            d = e;
            continue;
           }
           e = b + 16 | 0;
           f = c[e >> 2] | 0;
           if (!f) break; else {
            b = f;
            d = e;
           }
          }
          if (d >>> 0 < j >>> 0) ia(); else {
           c[d >> 2] = 0;
           A = b;
           break;
          }
         } else {
          f = c[a + 8 >> 2] | 0;
          if (f >>> 0 < j >>> 0) ia();
          b = f + 12 | 0;
          if ((c[b >> 2] | 0) != (a | 0)) ia();
          d = e + 8 | 0;
          if ((c[d >> 2] | 0) == (a | 0)) {
           c[b >> 2] = e;
           c[d >> 2] = f;
           A = e;
           break;
          } else ia();
         } while (0);
         if (!g) break;
         b = c[a + 28 >> 2] | 0;
         d = 76728 + (b << 2) | 0;
         do if ((a | 0) == (c[d >> 2] | 0)) {
          c[d >> 2] = A;
          if (A | 0) break;
          c[19107] = c[19107] & ~(1 << b);
          break e;
         } else {
          if (g >>> 0 < (c[19110] | 0) >>> 0) ia();
          b = g + 16 | 0;
          if ((c[b >> 2] | 0) == (a | 0)) c[b >> 2] = A; else c[g + 20 >> 2] = A;
          if (!A) break e;
         } while (0);
         e = c[19110] | 0;
         if (A >>> 0 < e >>> 0) ia();
         c[A + 24 >> 2] = g;
         b = a + 16 | 0;
         d = c[b >> 2] | 0;
         do if (d | 0) if (d >>> 0 < e >>> 0) ia(); else {
          c[A + 16 >> 2] = d;
          c[d + 24 >> 2] = A;
          break;
         } while (0);
         b = c[b + 4 >> 2] | 0;
         if (!b) break;
         if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
          c[A + 20 >> 2] = b;
          c[b + 24 >> 2] = A;
          break;
         }
        } while (0);
        a = a + h | 0;
        f = h + k | 0;
       } else f = k;
       a = a + 4 | 0;
       c[a >> 2] = c[a >> 2] & -2;
       c[m + 4 >> 2] = f | 1;
       c[m + f >> 2] = f;
       a = f >>> 3;
       if (f >>> 0 < 256) {
        d = 76464 + (a << 1 << 2) | 0;
        b = c[19106] | 0;
        a = 1 << a;
        do if (!(b & a)) {
         c[19106] = b | a;
         B = d;
         C = d + 8 | 0;
        } else {
         a = d + 8 | 0;
         b = c[a >> 2] | 0;
         if (b >>> 0 >= (c[19110] | 0) >>> 0) {
          B = b;
          C = a;
          break;
         }
         ia();
        } while (0);
        c[C >> 2] = m;
        c[B + 12 >> 2] = m;
        c[m + 8 >> 2] = B;
        c[m + 12 >> 2] = d;
        break;
       }
       a = f >>> 8;
       do if (!a) a = 0; else {
        if (f >>> 0 > 16777215) {
         a = 31;
         break;
        }
        B = (a + 1048320 | 0) >>> 16 & 8;
        C = a << B;
        A = (C + 520192 | 0) >>> 16 & 4;
        C = C << A;
        a = (C + 245760 | 0) >>> 16 & 2;
        a = 14 - (A | B | a) + (C << a >>> 15) | 0;
        a = f >>> (a + 7 | 0) & 1 | a << 1;
       } while (0);
       e = 76728 + (a << 2) | 0;
       c[m + 28 >> 2] = a;
       b = m + 16 | 0;
       c[b + 4 >> 2] = 0;
       c[b >> 2] = 0;
       b = c[19107] | 0;
       d = 1 << a;
       if (!(b & d)) {
        c[19107] = b | d;
        c[e >> 2] = m;
        c[m + 24 >> 2] = e;
        c[m + 12 >> 2] = m;
        c[m + 8 >> 2] = m;
        break;
       }
       b = f << ((a | 0) == 31 ? 0 : 25 - (a >>> 1) | 0);
       e = c[e >> 2] | 0;
       while (1) {
        if ((c[e + 4 >> 2] & -8 | 0) == (f | 0)) {
         w = 278;
         break;
        }
        d = e + 16 + (b >>> 31 << 2) | 0;
        a = c[d >> 2] | 0;
        if (!a) {
         w = 275;
         break;
        } else {
         b = b << 1;
         e = a;
        }
       }
       if ((w | 0) == 275) if (d >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
        c[d >> 2] = m;
        c[m + 24 >> 2] = e;
        c[m + 12 >> 2] = m;
        c[m + 8 >> 2] = m;
        break;
       } else if ((w | 0) == 278) {
        a = e + 8 | 0;
        b = c[a >> 2] | 0;
        C = c[19110] | 0;
        if (b >>> 0 >= C >>> 0 & e >>> 0 >= C >>> 0) {
         c[b + 12 >> 2] = m;
         c[a >> 2] = m;
         c[m + 8 >> 2] = b;
         c[m + 12 >> 2] = e;
         c[m + 24 >> 2] = 0;
         break;
        } else ia();
       }
      } while (0);
      C = n + 8 | 0;
      i = D;
      return C | 0;
     } else b = 76872;
     while (1) {
      a = c[b >> 2] | 0;
      if (a >>> 0 <= l >>> 0) {
       d = a + (c[b + 4 >> 2] | 0) | 0;
       if (d >>> 0 > l >>> 0) break;
      }
      b = c[b + 8 >> 2] | 0;
     }
     f = d + -47 | 0;
     b = f + 8 | 0;
     b = f + ((b & 7 | 0) == 0 ? 0 : 0 - b & 7) | 0;
     f = l + 16 | 0;
     b = b >>> 0 < f >>> 0 ? l : b;
     a = b + 8 | 0;
     e = g + 8 | 0;
     e = (e & 7 | 0) == 0 ? 0 : 0 - e & 7;
     C = g + e | 0;
     e = h + -40 - e | 0;
     c[19112] = C;
     c[19109] = e;
     c[C + 4 >> 2] = e | 1;
     c[C + e + 4 >> 2] = 40;
     c[19113] = c[19228];
     e = b + 4 | 0;
     c[e >> 2] = 27;
     c[a >> 2] = c[19218];
     c[a + 4 >> 2] = c[19219];
     c[a + 8 >> 2] = c[19220];
     c[a + 12 >> 2] = c[19221];
     c[19218] = g;
     c[19219] = h;
     c[19221] = 0;
     c[19220] = a;
     a = b + 24 | 0;
     do {
      a = a + 4 | 0;
      c[a >> 2] = 7;
     } while ((a + 4 | 0) >>> 0 < d >>> 0);
     if ((b | 0) != (l | 0)) {
      g = b - l | 0;
      c[e >> 2] = c[e >> 2] & -2;
      c[l + 4 >> 2] = g | 1;
      c[b >> 2] = g;
      a = g >>> 3;
      if (g >>> 0 < 256) {
       d = 76464 + (a << 1 << 2) | 0;
       b = c[19106] | 0;
       a = 1 << a;
       if (!(b & a)) {
        c[19106] = b | a;
        y = d;
        z = d + 8 | 0;
       } else {
        a = d + 8 | 0;
        b = c[a >> 2] | 0;
        if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
         y = b;
         z = a;
        }
       }
       c[z >> 2] = l;
       c[y + 12 >> 2] = l;
       c[l + 8 >> 2] = y;
       c[l + 12 >> 2] = d;
       break;
      }
      a = g >>> 8;
      if (!a) d = 0; else if (g >>> 0 > 16777215) d = 31; else {
       B = (a + 1048320 | 0) >>> 16 & 8;
       C = a << B;
       A = (C + 520192 | 0) >>> 16 & 4;
       C = C << A;
       d = (C + 245760 | 0) >>> 16 & 2;
       d = 14 - (A | B | d) + (C << d >>> 15) | 0;
       d = g >>> (d + 7 | 0) & 1 | d << 1;
      }
      e = 76728 + (d << 2) | 0;
      c[l + 28 >> 2] = d;
      c[l + 20 >> 2] = 0;
      c[f >> 2] = 0;
      a = c[19107] | 0;
      b = 1 << d;
      if (!(a & b)) {
       c[19107] = a | b;
       c[e >> 2] = l;
       c[l + 24 >> 2] = e;
       c[l + 12 >> 2] = l;
       c[l + 8 >> 2] = l;
       break;
      }
      b = g << ((d | 0) == 31 ? 0 : 25 - (d >>> 1) | 0);
      e = c[e >> 2] | 0;
      while (1) {
       if ((c[e + 4 >> 2] & -8 | 0) == (g | 0)) {
        w = 304;
        break;
       }
       d = e + 16 + (b >>> 31 << 2) | 0;
       a = c[d >> 2] | 0;
       if (!a) {
        w = 301;
        break;
       } else {
        b = b << 1;
        e = a;
       }
      }
      if ((w | 0) == 301) if (d >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
       c[d >> 2] = l;
       c[l + 24 >> 2] = e;
       c[l + 12 >> 2] = l;
       c[l + 8 >> 2] = l;
       break;
      } else if ((w | 0) == 304) {
       a = e + 8 | 0;
       b = c[a >> 2] | 0;
       C = c[19110] | 0;
       if (b >>> 0 >= C >>> 0 & e >>> 0 >= C >>> 0) {
        c[b + 12 >> 2] = l;
        c[a >> 2] = l;
        c[l + 8 >> 2] = b;
        c[l + 12 >> 2] = e;
        c[l + 24 >> 2] = 0;
        break;
       } else ia();
      }
     }
    } while (0);
    a = c[19109] | 0;
    if (a >>> 0 > o >>> 0) {
     A = a - o | 0;
     c[19109] = A;
     C = c[19112] | 0;
     B = C + o | 0;
     c[19112] = B;
     c[B + 4 >> 2] = A | 1;
     c[C + 4 >> 2] = o | 3;
     C = C + 8 | 0;
     i = D;
     return C | 0;
    }
   }
   c[(kd() | 0) >> 2] = 12;
   C = 0;
   i = D;
   return C | 0;
  }

  function Hd(e, f, g, j, k) {
   e = e | 0;
   f = f | 0;
   g = g | 0;
   j = j | 0;
   k = k | 0;
   var m = 0, n = 0, o = 0, p = 0, q = 0.0, r = 0, s = 0, t = 0, u = 0, v = 0.0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0, C = 0, E = 0, F = 0, G = 0, H = 0, I = 0, J = 0, K = 0, L = 0, M = 0, N = 0, O = 0, P = 0, Q = 0, R = 0, T = 0, U = 0, V = 0, W = 0, X = 0, Y = 0, Z = 0, _ = 0, $ = 0, aa = 0, ba = 0, ca = 0, da = 0, ea = 0, fa = 0, ga = 0, ha = 0, ia = 0, ja = 0;
   ja = i;
   i = i + 624 | 0;
   fa = ja + 24 | 0;
   ga = ja + 16 | 0;
   ha = ja + 588 | 0;
   Y = ja + 576 | 0;
   ia = ja;
   T = ja + 536 | 0;
   N = ja + 8 | 0;
   O = ja + 528 | 0;
   P = (e | 0) != 0;
   Q = T + 40 | 0;
   R = Q;
   T = T + 39 | 0;
   U = N + 4 | 0;
   V = ha;
   W = 0 - V | 0;
   X = Y + 12 | 0;
   Y = Y + 11 | 0;
   Z = X;
   _ = Z - V | 0;
   $ = -2 - V | 0;
   aa = Z + 2 | 0;
   ba = fa + 288 | 0;
   ca = ha + 9 | 0;
   da = ca;
   ea = ha + 8 | 0;
   n = 0;
   m = 0;
   s = 0;
   a : while (1) {
    do if ((m | 0) > -1) if ((n | 0) > (2147483647 - m | 0)) {
     c[(kd() | 0) >> 2] = 75;
     m = -1;
     break;
    } else {
     m = n + m | 0;
     break;
    } while (0);
    n = a[f >> 0] | 0;
    if (!(n << 24 >> 24)) {
     M = 243;
     break;
    } else o = f;
    b : while (1) {
     switch (n << 24 >> 24) {
     case 37:
      {
       n = o;
       M = 9;
       break b;
      }
     case 0:
      {
       n = o;
       break b;
      }
     default:
      {}
     }
     n = o + 1 | 0;
     o = n;
     n = a[n >> 0] | 0;
    }
    c : do if ((M | 0) == 9) while (1) {
     M = 0;
     if ((a[o + 1 >> 0] | 0) != 37) break c;
     n = n + 1 | 0;
     o = o + 2 | 0;
     if ((a[o >> 0] | 0) == 37) M = 9; else break;
    } while (0);
    n = n - f | 0;
    if (P) if (!(c[e >> 2] & 32)) Jd(f, n, e) | 0;
    if (n | 0) {
     f = o;
     continue;
    }
    r = o + 1 | 0;
    p = a[r >> 0] | 0;
    n = (p << 24 >> 24) + -48 | 0;
    if (n >>> 0 < 10) {
     u = (a[o + 2 >> 0] | 0) == 36;
     r = u ? o + 3 | 0 : r;
     w = u ? n : -1;
     u = u ? 1 : s;
     n = a[r >> 0] | 0;
    } else {
     w = -1;
     u = s;
     n = p;
    }
    o = (n << 24 >> 24) + -32 | 0;
    d : do if (o >>> 0 < 32) {
     p = 0;
     do {
      if (!(1 << o & 75913)) break d;
      p = 1 << (n << 24 >> 24) + -32 | p;
      r = r + 1 | 0;
      n = a[r >> 0] | 0;
      o = (n << 24 >> 24) + -32 | 0;
     } while (o >>> 0 < 32);
    } else p = 0; while (0);
    do if (n << 24 >> 24 == 42) {
     t = r + 1 | 0;
     n = a[t >> 0] | 0;
     o = (n << 24 >> 24) + -48 | 0;
     if (o >>> 0 < 10) if ((a[r + 2 >> 0] | 0) == 36) {
      c[k + (o << 2) >> 2] = 10;
      n = c[j + ((a[t >> 0] | 0) + -48 << 3) >> 2] | 0;
      o = 1;
      t = r + 3 | 0;
     } else M = 24; else M = 24;
     if ((M | 0) == 24) {
      M = 0;
      if (u | 0) {
       m = -1;
       break a;
      }
      if (!P) {
       s = 0;
       L = 0;
       r = t;
       break;
      }
      o = (c[g >> 2] | 0) + (4 - 1) & ~(4 - 1);
      n = c[o >> 2] | 0;
      c[g >> 2] = o + 4;
      o = 0;
     }
     L = (n | 0) < 0;
     s = L ? 0 - n | 0 : n;
     p = L ? p | 8192 : p;
     L = o;
     r = t;
     n = a[t >> 0] | 0;
    } else {
     o = (n << 24 >> 24) + -48 | 0;
     if (o >>> 0 < 10) {
      s = 0;
      do {
       s = (s * 10 | 0) + o | 0;
       r = r + 1 | 0;
       n = a[r >> 0] | 0;
       o = (n << 24 >> 24) + -48 | 0;
      } while (o >>> 0 < 10);
      if ((s | 0) < 0) {
       m = -1;
       break a;
      } else L = u;
     } else {
      s = 0;
      L = u;
     }
    } while (0);
    e : do if (n << 24 >> 24 == 46) {
     n = r + 1 | 0;
     o = a[n >> 0] | 0;
     if (o << 24 >> 24 != 42) {
      r = (o << 24 >> 24) + -48 | 0;
      if (r >>> 0 < 10) o = 0; else {
       x = 0;
       break;
      }
      while (1) {
       o = (o * 10 | 0) + r | 0;
       n = n + 1 | 0;
       r = (a[n >> 0] | 0) + -48 | 0;
       if (r >>> 0 >= 10) {
        x = o;
        break e;
       }
      }
     }
     n = r + 2 | 0;
     o = (a[n >> 0] | 0) + -48 | 0;
     if (o >>> 0 < 10) if ((a[r + 3 >> 0] | 0) == 36) {
      c[k + (o << 2) >> 2] = 10;
      x = c[j + ((a[n >> 0] | 0) + -48 << 3) >> 2] | 0;
      n = r + 4 | 0;
      break;
     }
     if (L | 0) {
      m = -1;
      break a;
     }
     if (P) {
      K = (c[g >> 2] | 0) + (4 - 1) & ~(4 - 1);
      x = c[K >> 2] | 0;
      c[g >> 2] = K + 4;
     } else x = 0;
    } else {
     x = -1;
     n = r;
    } while (0);
    u = 0;
    while (1) {
     o = (a[n >> 0] | 0) + -65 | 0;
     if (o >>> 0 > 57) {
      m = -1;
      break a;
     }
     K = n + 1 | 0;
     o = a[63729 + (u * 58 | 0) + o >> 0] | 0;
     r = o & 255;
     if ((r + -1 | 0) >>> 0 < 8) {
      u = r;
      n = K;
     } else break;
    }
    if (!(o << 24 >> 24)) {
     m = -1;
     break;
    }
    t = (w | 0) > -1;
    do if (o << 24 >> 24 == 19) if (t) {
     m = -1;
     break a;
    } else M = 51; else {
     if (t) {
      c[k + (w << 2) >> 2] = r;
      I = j + (w << 3) | 0;
      J = c[I + 4 >> 2] | 0;
      M = ia;
      c[M >> 2] = c[I >> 2];
      c[M + 4 >> 2] = J;
      M = 51;
      break;
     }
     if (!P) {
      m = 0;
      break a;
     }
     Kd(ia, r, g);
    } while (0);
    if ((M | 0) == 51) {
     M = 0;
     if (!P) {
      n = 0;
      s = L;
      f = K;
      continue;
     }
    }
    F = a[n >> 0] | 0;
    F = (u | 0) != 0 & (F & 15 | 0) == 3 ? F & -33 : F;
    t = p & -65537;
    J = (p & 8192 | 0) == 0 ? p : t;
    f : do switch (F | 0) {
    case 110:
     switch ((u & 255) << 24 >> 24) {
     case 0:
      {
       c[c[ia >> 2] >> 2] = m;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 1:
      {
       c[c[ia >> 2] >> 2] = m;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 2:
      {
       n = c[ia >> 2] | 0;
       c[n >> 2] = m;
       c[n + 4 >> 2] = ((m | 0) < 0) << 31 >> 31;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 3:
      {
       b[c[ia >> 2] >> 1] = m;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 4:
      {
       a[c[ia >> 2] >> 0] = m;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 6:
      {
       c[c[ia >> 2] >> 2] = m;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     case 7:
      {
       n = c[ia >> 2] | 0;
       c[n >> 2] = m;
       c[n + 4 >> 2] = ((m | 0) < 0) << 31 >> 31;
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     default:
      {
       n = 0;
       s = L;
       f = K;
       continue a;
      }
     }
    case 112:
     {
      t = 120;
      u = x >>> 0 > 8 ? x : 8;
      n = J | 8;
      M = 63;
      break;
     }
    case 88:
    case 120:
     {
      t = F;
      u = x;
      n = J;
      M = 63;
      break;
     }
    case 111:
     {
      o = ia;
      n = c[o >> 2] | 0;
      o = c[o + 4 >> 2] | 0;
      if ((n | 0) == 0 & (o | 0) == 0) f = Q; else {
       f = Q;
       do {
        f = f + -1 | 0;
        a[f >> 0] = n & 7 | 48;
        n = Fe(n | 0, o | 0, 3) | 0;
        o = D;
       } while (!((n | 0) == 0 & (o | 0) == 0));
      }
      if (!(J & 8)) {
       o = 0;
       p = 64209;
       r = x;
       n = J;
       M = 76;
      } else {
       r = R - f | 0;
       o = 0;
       p = 64209;
       r = (x | 0) > (r | 0) ? x : r + 1 | 0;
       n = J;
       M = 76;
      }
      break;
     }
    case 105:
    case 100:
     {
      f = ia;
      n = c[f >> 2] | 0;
      f = c[f + 4 >> 2] | 0;
      if ((f | 0) < 0) {
       n = Ce(0, 0, n | 0, f | 0) | 0;
       f = D;
       o = ia;
       c[o >> 2] = n;
       c[o + 4 >> 2] = f;
       o = 1;
       p = 64209;
       M = 75;
       break f;
      }
      if (!(J & 2048)) {
       p = J & 1;
       o = p;
       p = (p | 0) == 0 ? 64209 : 64211;
       M = 75;
      } else {
       o = 1;
       p = 64210;
       M = 75;
      }
      break;
     }
    case 117:
     {
      f = ia;
      o = 0;
      p = 64209;
      n = c[f >> 2] | 0;
      f = c[f + 4 >> 2] | 0;
      M = 75;
      break;
     }
    case 99:
     {
      a[T >> 0] = c[ia >> 2];
      f = T;
      w = 0;
      u = 64209;
      o = Q;
      n = 1;
      break;
     }
    case 109:
     {
      n = Md(c[(kd() | 0) >> 2] | 0) | 0;
      M = 81;
      break;
     }
    case 115:
     {
      n = c[ia >> 2] | 0;
      n = n | 0 ? n : 64219;
      M = 81;
      break;
     }
    case 67:
     {
      c[N >> 2] = c[ia >> 2];
      c[U >> 2] = 0;
      c[ia >> 2] = N;
      t = -1;
      o = N;
      M = 85;
      break;
     }
    case 83:
     {
      n = c[ia >> 2] | 0;
      if (!x) {
       Od(e, 32, s, 0, J);
       n = 0;
       M = 96;
      } else {
       t = x;
       o = n;
       M = 85;
      }
      break;
     }
    case 65:
    case 71:
    case 70:
    case 69:
    case 97:
    case 103:
    case 102:
    case 101:
     {
      q = +h[ia >> 3];
      c[ga >> 2] = 0;
      h[l >> 3] = q;
      if ((c[l + 4 >> 2] | 0) < 0) {
       q = -q;
       H = 1;
       I = 64226;
      } else {
       n = J & 1;
       if (!(J & 2048)) {
        H = n;
        I = (n | 0) == 0 ? 64227 : 64232;
       } else {
        H = 1;
        I = 64229;
       }
      }
      h[l >> 3] = q;
      G = c[l + 4 >> 2] & 2146435072;
      do if (G >>> 0 < 2146435072 | (G | 0) == 2146435072 & 0 < 0) {
       v = +Qd(q, ga) * 2.0;
       f = v != 0.0;
       if (f) c[ga >> 2] = (c[ga >> 2] | 0) + -1;
       z = F | 32;
       if ((z | 0) == 97) {
        r = F & 32;
        w = (r | 0) == 0 ? I : I + 9 | 0;
        u = H | 2;
        n = 12 - x | 0;
        do if (x >>> 0 > 11 | (n | 0) == 0) q = v; else {
         q = 8.0;
         do {
          n = n + -1 | 0;
          q = q * 16.0;
         } while ((n | 0) != 0);
         if ((a[w >> 0] | 0) == 45) {
          q = -(q + (-v - q));
          break;
         } else {
          q = v + q - q;
          break;
         }
        } while (0);
        f = c[ga >> 2] | 0;
        n = (f | 0) < 0 ? 0 - f | 0 : f;
        n = Ld(n, ((n | 0) < 0) << 31 >> 31, X) | 0;
        if ((n | 0) == (X | 0)) {
         a[Y >> 0] = 48;
         n = Y;
        }
        a[n + -1 >> 0] = (f >> 31 & 2) + 43;
        t = n + -2 | 0;
        a[t >> 0] = F + 15;
        p = (x | 0) < 1;
        o = (J & 8 | 0) == 0;
        n = ha;
        do {
         I = ~~q;
         f = n + 1 | 0;
         a[n >> 0] = d[64193 + I >> 0] | r;
         q = (q - +(I | 0)) * 16.0;
         do if ((f - V | 0) == 1) {
          if (o & (p & q == 0.0)) {
           n = f;
           break;
          }
          a[f >> 0] = 46;
          n = n + 2 | 0;
         } else n = f; while (0);
        } while (q != 0.0);
        p = t;
        o = (x | 0) != 0 & ($ + n | 0) < (x | 0) ? aa + x - p | 0 : _ - p + n | 0;
        r = o + u | 0;
        Od(e, 32, s, r, J);
        if (!(c[e >> 2] & 32)) Jd(w, u, e) | 0;
        Od(e, 48, s, r, J ^ 65536);
        f = n - V | 0;
        if (!(c[e >> 2] & 32)) Jd(ha, f, e) | 0;
        n = Z - p | 0;
        Od(e, 48, o - (f + n) | 0, 0, 0);
        if (!(c[e >> 2] & 32)) Jd(t, n, e) | 0;
        Od(e, 32, s, r, J ^ 8192);
        n = (r | 0) < (s | 0) ? s : r;
        break;
       }
       n = (x | 0) < 0 ? 6 : x;
       if (f) {
        f = (c[ga >> 2] | 0) + -28 | 0;
        c[ga >> 2] = f;
        q = v * 268435456.0;
       } else {
        q = v;
        f = c[ga >> 2] | 0;
       }
       G = (f | 0) < 0 ? fa : ba;
       o = G;
       do {
        E = ~~q >>> 0;
        c[o >> 2] = E;
        o = o + 4 | 0;
        q = (q - +(E >>> 0)) * 1.0e9;
       } while (q != 0.0);
       if ((f | 0) > 0) {
        p = G;
        t = o;
        while (1) {
         r = (f | 0) > 29 ? 29 : f;
         f = t + -4 | 0;
         do if (f >>> 0 >= p >>> 0) {
          o = 0;
          do {
           C = Ge(c[f >> 2] | 0, 0, r | 0) | 0;
           C = De(C | 0, D | 0, o | 0, 0) | 0;
           E = D;
           B = Pe(C | 0, E | 0, 1e9, 0) | 0;
           c[f >> 2] = B;
           o = Je(C | 0, E | 0, 1e9, 0) | 0;
           f = f + -4 | 0;
          } while (f >>> 0 >= p >>> 0);
          if (!o) break;
          p = p + -4 | 0;
          c[p >> 2] = o;
         } while (0);
         o = t;
         while (1) {
          if (o >>> 0 <= p >>> 0) break;
          f = o + -4 | 0;
          if (!(c[f >> 2] | 0)) o = f; else break;
         }
         f = (c[ga >> 2] | 0) - r | 0;
         c[ga >> 2] = f;
         if ((f | 0) > 0) t = o; else break;
        }
       } else p = G;
       if ((f | 0) < 0) {
        x = ((n + 25 | 0) / 9 | 0) + 1 | 0;
        y = (z | 0) == 102;
        do {
         w = 0 - f | 0;
         w = (w | 0) > 9 ? 9 : w;
         do if (p >>> 0 < o >>> 0) {
          r = (1 << w) + -1 | 0;
          t = 1e9 >>> w;
          u = 0;
          f = p;
          do {
           E = c[f >> 2] | 0;
           c[f >> 2] = (E >>> w) + u;
           u = S(E & r, t) | 0;
           f = f + 4 | 0;
          } while (f >>> 0 < o >>> 0);
          f = (c[p >> 2] | 0) == 0 ? p + 4 | 0 : p;
          if (!u) {
           p = f;
           f = o;
           break;
          }
          c[o >> 2] = u;
          p = f;
          f = o + 4 | 0;
         } else {
          p = (c[p >> 2] | 0) == 0 ? p + 4 | 0 : p;
          f = o;
         } while (0);
         o = y ? G : p;
         o = (f - o >> 2 | 0) > (x | 0) ? o + (x << 2) | 0 : f;
         f = (c[ga >> 2] | 0) + w | 0;
         c[ga >> 2] = f;
        } while ((f | 0) < 0);
       }
       E = G;
       do if (p >>> 0 < o >>> 0) {
        f = (E - p >> 2) * 9 | 0;
        t = c[p >> 2] | 0;
        if (t >>> 0 < 10) break; else r = 10;
        do {
         r = r * 10 | 0;
         f = f + 1 | 0;
        } while (t >>> 0 >= r >>> 0);
       } else f = 0; while (0);
       A = (z | 0) == 103;
       B = (n | 0) != 0;
       r = n - ((z | 0) != 102 ? f : 0) + ((B & A) << 31 >> 31) | 0;
       if ((r | 0) < (((o - E >> 2) * 9 | 0) + -9 | 0)) {
        r = r + 9216 | 0;
        u = G + 4 + (((r | 0) / 9 | 0) + -1024 << 2) | 0;
        r = ((r | 0) % 9 | 0) + 1 | 0;
        if ((r | 0) < 9) {
         t = 10;
         do {
          t = t * 10 | 0;
          r = r + 1 | 0;
         } while ((r | 0) != 9);
        } else t = 10;
        x = c[u >> 2] | 0;
        y = (x >>> 0) % (t >>> 0) | 0;
        r = (u + 4 | 0) == (o | 0);
        do if (r & (y | 0) == 0) r = u; else {
         v = (((x >>> 0) / (t >>> 0) | 0) & 1 | 0) == 0 ? 9007199254740992.0 : 9007199254740994.0;
         w = (t | 0) / 2 | 0;
         if (y >>> 0 < w >>> 0) q = .5; else q = r & (y | 0) == (w | 0) ? 1.0 : 1.5;
         do if (H) {
          if ((a[I >> 0] | 0) != 45) break;
          q = -q;
          v = -v;
         } while (0);
         r = x - y | 0;
         c[u >> 2] = r;
         if (!(v + q != v)) {
          r = u;
          break;
         }
         C = r + t | 0;
         c[u >> 2] = C;
         if (C >>> 0 > 999999999) {
          r = u;
          while (1) {
           f = r + -4 | 0;
           c[r >> 2] = 0;
           if (f >>> 0 < p >>> 0) {
            p = p + -4 | 0;
            c[p >> 2] = 0;
           }
           C = (c[f >> 2] | 0) + 1 | 0;
           c[f >> 2] = C;
           if (C >>> 0 > 999999999) r = f; else {
            u = f;
            break;
           }
          }
         }
         f = (E - p >> 2) * 9 | 0;
         t = c[p >> 2] | 0;
         if (t >>> 0 < 10) {
          r = u;
          break;
         } else r = 10;
         do {
          r = r * 10 | 0;
          f = f + 1 | 0;
         } while (t >>> 0 >= r >>> 0);
         r = u;
        } while (0);
        C = r + 4 | 0;
        o = o >>> 0 > C >>> 0 ? C : o;
       }
       y = 0 - f | 0;
       C = o;
       while (1) {
        if (C >>> 0 <= p >>> 0) {
         z = 0;
         break;
        }
        o = C + -4 | 0;
        if (!(c[o >> 2] | 0)) C = o; else {
         z = 1;
         break;
        }
       }
       do if (A) {
        n = (B & 1 ^ 1) + n | 0;
        if ((n | 0) > (f | 0) & (f | 0) > -5) {
         u = F + -1 | 0;
         n = n + -1 - f | 0;
        } else {
         u = F + -2 | 0;
         n = n + -1 | 0;
        }
        o = J & 8;
        if (o | 0) {
         w = o;
         break;
        }
        do if (z) {
         t = c[C + -4 >> 2] | 0;
         if (!t) {
          r = 9;
          break;
         }
         if (!((t >>> 0) % 10 | 0)) {
          r = 0;
          o = 10;
         } else {
          r = 0;
          break;
         }
         do {
          o = o * 10 | 0;
          r = r + 1 | 0;
         } while (!((t >>> 0) % (o >>> 0) | 0 | 0));
        } else r = 9; while (0);
        o = ((C - E >> 2) * 9 | 0) + -9 | 0;
        if ((u | 32 | 0) == 102) {
         w = o - r | 0;
         w = (w | 0) < 0 ? 0 : w;
         n = (n | 0) < (w | 0) ? n : w;
         w = 0;
         break;
        } else {
         w = o + f - r | 0;
         w = (w | 0) < 0 ? 0 : w;
         n = (n | 0) < (w | 0) ? n : w;
         w = 0;
         break;
        }
       } else {
        u = F;
        w = J & 8;
       } while (0);
       x = n | w;
       r = (x | 0) != 0 & 1;
       t = (u | 32 | 0) == 102;
       if (t) {
        y = 0;
        f = (f | 0) > 0 ? f : 0;
       } else {
        o = (f | 0) < 0 ? y : f;
        o = Ld(o, ((o | 0) < 0) << 31 >> 31, X) | 0;
        if ((Z - o | 0) < 2) do {
         o = o + -1 | 0;
         a[o >> 0] = 48;
        } while ((Z - o | 0) < 2);
        a[o + -1 >> 0] = (f >> 31 & 2) + 43;
        f = o + -2 | 0;
        a[f >> 0] = u;
        y = f;
        f = Z - f | 0;
       }
       A = H + 1 + n + r + f | 0;
       Od(e, 32, s, A, J);
       if (!(c[e >> 2] & 32)) Jd(I, H, e) | 0;
       Od(e, 48, s, A, J ^ 65536);
       do if (t) {
        p = p >>> 0 > G >>> 0 ? G : p;
        o = p;
        do {
         f = Ld(c[o >> 2] | 0, 0, ca) | 0;
         do if ((o | 0) == (p | 0)) {
          if ((f | 0) != (ca | 0)) break;
          a[ea >> 0] = 48;
          f = ea;
         } else {
          if (f >>> 0 <= ha >>> 0) break;
          Ee(ha | 0, 48, f - V | 0) | 0;
          do f = f + -1 | 0; while (f >>> 0 > ha >>> 0);
         } while (0);
         if (!(c[e >> 2] & 32)) Jd(f, da - f | 0, e) | 0;
         o = o + 4 | 0;
        } while (o >>> 0 <= G >>> 0);
        do if (x | 0) {
         if (c[e >> 2] & 32 | 0) break;
         Jd(64261, 1, e) | 0;
        } while (0);
        if ((n | 0) > 0 & o >>> 0 < C >>> 0) while (1) {
         f = Ld(c[o >> 2] | 0, 0, ca) | 0;
         if (f >>> 0 > ha >>> 0) {
          Ee(ha | 0, 48, f - V | 0) | 0;
          do f = f + -1 | 0; while (f >>> 0 > ha >>> 0);
         }
         if (!(c[e >> 2] & 32)) Jd(f, (n | 0) > 9 ? 9 : n, e) | 0;
         o = o + 4 | 0;
         f = n + -9 | 0;
         if (!((n | 0) > 9 & o >>> 0 < C >>> 0)) {
          n = f;
          break;
         } else n = f;
        }
        Od(e, 48, n + 9 | 0, 9, 0);
       } else {
        u = z ? C : p + 4 | 0;
        if ((n | 0) > -1) {
         t = (w | 0) == 0;
         r = p;
         do {
          f = Ld(c[r >> 2] | 0, 0, ca) | 0;
          if ((f | 0) == (ca | 0)) {
           a[ea >> 0] = 48;
           f = ea;
          }
          do if ((r | 0) == (p | 0)) {
           o = f + 1 | 0;
           if (!(c[e >> 2] & 32)) Jd(f, 1, e) | 0;
           if (t & (n | 0) < 1) {
            f = o;
            break;
           }
           if (c[e >> 2] & 32 | 0) {
            f = o;
            break;
           }
           Jd(64261, 1, e) | 0;
           f = o;
          } else {
           if (f >>> 0 <= ha >>> 0) break;
           Ee(ha | 0, 48, f + W | 0) | 0;
           do f = f + -1 | 0; while (f >>> 0 > ha >>> 0);
          } while (0);
          o = da - f | 0;
          if (!(c[e >> 2] & 32)) Jd(f, (n | 0) > (o | 0) ? o : n, e) | 0;
          n = n - o | 0;
          r = r + 4 | 0;
         } while (r >>> 0 < u >>> 0 & (n | 0) > -1);
        }
        Od(e, 48, n + 18 | 0, 18, 0);
        if (c[e >> 2] & 32 | 0) break;
        Jd(y, Z - y | 0, e) | 0;
       } while (0);
       Od(e, 32, s, A, J ^ 8192);
       n = (A | 0) < (s | 0) ? s : A;
      } else {
       r = (F & 32 | 0) != 0;
       p = q != q | 0.0 != 0.0;
       f = p ? 0 : H;
       o = f + 3 | 0;
       Od(e, 32, s, o, t);
       n = c[e >> 2] | 0;
       if (!(n & 32)) {
        Jd(I, f, e) | 0;
        n = c[e >> 2] | 0;
       }
       if (!(n & 32)) Jd(p ? (r ? 64253 : 64257) : r ? 64245 : 64249, 3, e) | 0;
       Od(e, 32, s, o, J ^ 8192);
       n = (o | 0) < (s | 0) ? s : o;
      } while (0);
      s = L;
      f = K;
      continue a;
     }
    default:
     {
      w = 0;
      u = 64209;
      o = Q;
      n = x;
      t = J;
     }
    } while (0);
    g : do if ((M | 0) == 63) {
     p = ia;
     o = c[p >> 2] | 0;
     p = c[p + 4 >> 2] | 0;
     r = t & 32;
     if ((o | 0) == 0 & (p | 0) == 0) {
      f = Q;
      o = 0;
      p = 0;
     } else {
      f = Q;
      do {
       f = f + -1 | 0;
       a[f >> 0] = d[64193 + (o & 15) >> 0] | r;
       o = Fe(o | 0, p | 0, 4) | 0;
       p = D;
      } while (!((o | 0) == 0 & (p | 0) == 0));
      p = ia;
      o = c[p >> 2] | 0;
      p = c[p + 4 >> 2] | 0;
     }
     p = (n & 8 | 0) == 0 | (o | 0) == 0 & (p | 0) == 0;
     o = p ? 0 : 2;
     p = p ? 64209 : 64209 + (t >> 4) | 0;
     r = u;
     M = 76;
    } else if ((M | 0) == 75) {
     f = Ld(n, f, Q) | 0;
     r = x;
     n = J;
     M = 76;
    } else if ((M | 0) == 81) {
     M = 0;
     J = Nd(n, 0, x) | 0;
     I = (J | 0) == 0;
     f = n;
     w = 0;
     u = 64209;
     o = I ? n + x | 0 : J;
     n = I ? x : J - n | 0;
    } else if ((M | 0) == 85) {
     M = 0;
     r = o;
     n = 0;
     f = 0;
     while (1) {
      p = c[r >> 2] | 0;
      if (!p) break;
      f = Pd(O, p) | 0;
      if ((f | 0) < 0 | f >>> 0 > (t - n | 0) >>> 0) break;
      n = f + n | 0;
      if (t >>> 0 > n >>> 0) r = r + 4 | 0; else break;
     }
     if ((f | 0) < 0) {
      m = -1;
      break a;
     }
     Od(e, 32, s, n, J);
     if (!n) {
      n = 0;
      M = 96;
     } else {
      p = 0;
      while (1) {
       f = c[o >> 2] | 0;
       if (!f) {
        M = 96;
        break g;
       }
       f = Pd(O, f) | 0;
       p = f + p | 0;
       if ((p | 0) > (n | 0)) {
        M = 96;
        break g;
       }
       if (!(c[e >> 2] & 32)) Jd(O, f, e) | 0;
       if (p >>> 0 >= n >>> 0) {
        M = 96;
        break;
       } else o = o + 4 | 0;
      }
     }
    } while (0);
    if ((M | 0) == 96) {
     M = 0;
     Od(e, 32, s, n, J ^ 8192);
     n = (s | 0) > (n | 0) ? s : n;
     s = L;
     f = K;
     continue;
    }
    if ((M | 0) == 76) {
     M = 0;
     t = (r | 0) > -1 ? n & -65537 : n;
     n = ia;
     n = (c[n >> 2] | 0) != 0 | (c[n + 4 >> 2] | 0) != 0;
     if ((r | 0) != 0 | n) {
      n = (n & 1 ^ 1) + (R - f) | 0;
      w = o;
      u = p;
      o = Q;
      n = (r | 0) > (n | 0) ? r : n;
     } else {
      f = Q;
      w = o;
      u = p;
      o = Q;
      n = 0;
     }
    }
    r = o - f | 0;
    o = (n | 0) < (r | 0) ? r : n;
    p = o + w | 0;
    n = (s | 0) < (p | 0) ? p : s;
    Od(e, 32, n, p, t);
    if (!(c[e >> 2] & 32)) Jd(u, w, e) | 0;
    Od(e, 48, n, p, t ^ 65536);
    Od(e, 48, o, r, 0);
    if (!(c[e >> 2] & 32)) Jd(f, r, e) | 0;
    Od(e, 32, n, p, t ^ 8192);
    s = L;
    f = K;
   }
   h : do if ((M | 0) == 243) if (!e) if (!s) m = 0; else {
    m = 1;
    while (1) {
     n = c[k + (m << 2) >> 2] | 0;
     if (!n) break;
     Kd(j + (m << 3) | 0, n, g);
     m = m + 1 | 0;
     if ((m | 0) >= 10) {
      m = 1;
      break h;
     }
    }
    while (1) {
     if (c[k + (m << 2) >> 2] | 0) {
      m = -1;
      break h;
     }
     m = m + 1 | 0;
     if ((m | 0) >= 10) {
      m = 1;
      break;
     }
    }
   } while (0);
   i = ja;
   return m | 0;
  }

  function Zb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0;
   B = i;
   i = i + 384 | 0;
   x = B + 40 | 0;
   w = B + 32 | 0;
   v = B + 24 | 0;
   z = B + 16 | 0;
   y = B + 8 | 0;
   u = B;
   m = B + 80 | 0;
   n = B + 76 | 0;
   o = B + 72 | 0;
   p = B + 68 | 0;
   q = B + 64 | 0;
   r = B + 60 | 0;
   s = B + 56 | 0;
   t = B + 52 | 0;
   g = B + 248 | 0;
   h = B + 216 | 0;
   j = B + 88 | 0;
   k = B + 48 | 0;
   l = B + 44 | 0;
   c[m >> 2] = b;
   c[n >> 2] = e;
   c[q >> 2] = c[18878];
   c[r >> 2] = c[18879];
   c[t >> 2] = c[m >> 2];
   c[18878] = c[18880];
   c[18879] = c[18881];
   c[18882] = 1;
   f = Lc() | 0;
   c[p >> 2] = f;
   c[o >> 2] = f;
   a : while (1) {
    if (!(a[c[m >> 2] >> 0] | 0)) break;
    if (a[1092353] & 1) {
     c[u >> 2] = a[c[m >> 2] >> 0];
     ve(61999, u) | 0;
    }
    do switch (a[c[m >> 2] >> 0] | 0) {
    case 10:
    case 32:
     {
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 126:
     {
      if (c[18882] | 0) $b(44, 128); else Ya(5, 0, c[t >> 2] | 0) | 0;
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 42:
     {
      if (c[18882] | 0) ac(64261) | 0; else $b(1, 20);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 47:
     {
      $b(2, 20);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 37:
     if (c[18882] | 0) {
      c[m >> 2] = dc((c[m >> 2] | 0) + 1 | 0) | 0;
      continue a;
     } else {
      $b(3, 20);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 63:
     {
      $b(4, 10);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 43:
     {
      $b(5, 19);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 45:
     {
      if (c[18882] | 0) $b(45, 128); else $b(6, 19);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 62:
     {
      if (c[18882] | 0) {
       $b(46, 128);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       continue a;
      }
      do if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 62) {
       $b(7, 18);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      } else if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 61) {
       $b(8, 17);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       break;
      } else {
       $b(9, 17);
       break;
      } while (0);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 60:
     {
      if (c[18882] | 0) {
       $b(47, 128);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       continue a;
      }
      do if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 60) {
       $b(10, 18);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      } else if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 61) {
       $b(11, 17);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       break;
      } else {
       $b(12, 17);
       break;
      } while (0);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 61:
     {
      if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 61) c[m >> 2] = (c[m >> 2] | 0) + 1;
      $b(13, 16);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 33:
     {
      if (c[18882] | 0) $b(48, 128); else {
       $b(14, 16);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      }
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 38:
     {
      if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 38) {
       $b(15, 12);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      } else $b(16, 15);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 94:
     {
      $b(17, 14);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 124:
     {
      if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 124) {
       $b(18, 11);
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      } else $b(19, 13);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 40:
     {
      if (c[n >> 2] | 0) {
       a[(c[p >> 2] | 0) + 13 >> 0] = 12;
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       continue a;
      } else A = 59;
      break;
     }
    case 91:
     {
      A = 59;
      break;
     }
    case 41:
     {
      if (c[n >> 2] | 0) {
       if ((d[(c[p >> 2] | 0) + 13 >> 0] | 0) == 12) if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 44) if ((a[(c[m >> 2] | 0) + 2 >> 0] | 32 | 0) == 121) {
        a[(c[p >> 2] | 0) + 13 >> 0] = 11;
        c[m >> 2] = (c[m >> 2] | 0) + 2;
       }
       if ((d[(c[p >> 2] | 0) + 13 >> 0] | 0) == 12) if ((a[(c[m >> 2] | 0) + 1 >> 0] | 0) == 44) if ((a[(c[m >> 2] | 0) + 2 >> 0] | 32 | 0) == 120) {
        c[y >> 2] = c[m >> 2];
        Dd(g, 62023, y) | 0;
        Ya(10, 0, c[t >> 2] | 0) | 0;
        c[16552] = (c[16552] | 0) + 1;
        c[16550] = c[16550] | 1;
       }
       c[m >> 2] = (c[m >> 2] | 0) + 1;
       continue a;
      }
      break;
     }
    case 93:
     break;
    case 35:
     {
      a[(c[p >> 2] | 0) + 13 >> 0] = 1;
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      c[n >> 2] = 0;
      continue a;
     }
    case 44:
     {
      while (1) {
       if ((c[18881] | 0) == (c[18879] | 0)) break;
       zc();
      }
      c[18882] = 1;
      c[s >> 2] = a[(c[m >> 2] | 0) + 1 >> 0] | 32;
      if ((c[s >> 2] | 0) == 120 ? (d[(c[p >> 2] | 0) + 13 >> 0] | 0) == 12 : 0) if (Ac(a[(c[m >> 2] | 0) + 2 >> 0] | 0) | 0) A = 89; else {
       a[(c[p >> 2] | 0) + 13 >> 0] = 10;
       c[m >> 2] = (c[m >> 2] | 0) + 1;
      } else A = 89;
      do if ((A | 0) == 89) {
       A = 0;
       if ((c[s >> 2] | 0) == 121 ? (d[(c[p >> 2] | 0) + 13 >> 0] | 0) == 12 : 0) if (c[n >> 2] | 0 ? (a[(c[m >> 2] | 0) + 2 >> 0] | 0) == 41 : 0) {
        c[v >> 2] = c[m >> 2];
        Dd(j, 62023, v) | 0;
        Ya(10, 0, c[t >> 2] | 0) | 0;
        c[16552] = (c[16552] | 0) + 1;
        c[16550] = c[16550] | 1;
        a[(c[p >> 2] | 0) + 13 >> 0] = 14;
        c[m >> 2] = (c[m >> 2] | 0) + 1;
        break;
       }
       if ((c[s >> 2] | 0) == 120) if (!(Ac(a[(c[m >> 2] | 0) + 2 >> 0] | 0) | 0)) {
        a[(c[p >> 2] | 0) + 13 >> 0] = 13;
        c[m >> 2] = (c[m >> 2] | 0) + 1;
        if ((c[18865] | 0) == 6) c[18865] = 7;
        if ((c[18865] | 0) == 3) c[18865] = 4;
        if ((c[18865] | 0) != 12) break;
        c[18865] = 13;
        break;
       }
       if ((c[s >> 2] | 0) == 121) if (!(Ac(a[(c[m >> 2] | 0) + 2 >> 0] | 0) | 0)) {
        a[(c[p >> 2] | 0) + 13 >> 0] = 14;
        c[m >> 2] = (c[m >> 2] | 0) + 1;
        if ((c[18865] | 0) == 6) c[18865] = 8;
        if ((c[18865] | 0) == 3) c[18865] = 5;
        if ((c[18865] | 0) != 12) break;
        c[18865] = 14;
        break;
       }
       c[k >> 2] = Lc() | 0;
       c[c[p >> 2] >> 2] = c[k >> 2];
       c[18880] = (c[18880] | 0) + -1;
       if ((c[18880] | 0) < (c[18878] | 0)) Ya(5, 0, c[t >> 2] | 0) | 0;
       if ((c[18880] | 0) > (c[18878] | 0)) Ya(5, 0, c[t >> 2] | 0) | 0;
       c[(c[p >> 2] | 0) + 16 >> 2] = c[75660 + (c[18880] << 2) >> 2];
       a[(c[p >> 2] | 0) + 12 >> 0] = a[1092356 + (c[18880] | 0) >> 0] | 0;
       f = c[75916 + (c[18880] << 2) >> 2] | 0;
       c[(c[p >> 2] | 0) + 8 >> 2] = f;
       if (f | 0) {
        f = (c[p >> 2] | 0) + 12 | 0;
        a[f >> 0] = d[f >> 0] | 8;
        if (a[1092353] & 1) {
         c[w >> 2] = c[(c[p >> 2] | 0) + 8 >> 2];
         ve(62057, w) | 0;
        }
       }
       c[p >> 2] = c[k >> 2];
      } while (0);
      c[m >> 2] = (c[m >> 2] | 0) + 1;
      continue a;
     }
    case 36:
     {
      c[m >> 2] = Bc((c[m >> 2] | 0) + 1 | 0) | 0;
      continue a;
     }
    case 39:
     {
      c[m >> 2] = Cc((c[m >> 2] | 0) + 1 | 0) | 0;
      continue a;
     }
    case 34:
     {
      c[m >> 2] = Dc((c[m >> 2] | 0) + 1 | 0) | 0;
      continue a;
     }
    default:
     {
      c[l >> 2] = c[m >> 2];
      while (1) {
       if ((a[c[l >> 2] >> 0] | 0) >= 48) b = (a[c[l >> 2] >> 0] | 0) <= 57; else b = 0;
       e = c[l >> 2] | 0;
       if (!b) break;
       c[l >> 2] = e + 1;
      }
      f = c[m >> 2] | 0;
      if ((a[e >> 0] | 0) == 36) {
       c[m >> 2] = ac(f) | 0;
       continue a;
      }
      b = c[m >> 2] | 0;
      if ((a[f >> 0] | 0) == 48) {
       c[m >> 2] = Ec(b) | 0;
       continue a;
      }
      if ((a[b >> 0] | 0) > 48) if ((a[c[m >> 2] >> 0] | 0) <= 57) {
       c[m >> 2] = Fc(c[m >> 2] | 0) | 0;
       continue a;
      }
      c[m >> 2] = ac(c[m >> 2] | 0) | 0;
      continue a;
     }
    } while (0);
    if ((A | 0) == 59) {
     A = 0;
     if ((c[18881] | 0) == 32) xe(62010) | 0; else {
      f = c[18881] | 0;
      c[18881] = f + 1;
      c[75532 + (f << 2) >> 2] = 0;
     }
     c[m >> 2] = (c[m >> 2] | 0) + 1;
     continue;
    }
    while (1) {
     if ((c[18881] | 0) == (c[18879] | 0)) break;
     if (!(c[75532 + ((c[18881] | 0) - 1 << 2) >> 2] | 0)) break;
     zc();
    }
    if ((c[18881] | 0) != (c[18879] | 0)) c[18881] = (c[18881] | 0) + -1;
    c[m >> 2] = (c[m >> 2] | 0) + 1;
    if ((c[18880] | 0) == (c[18878] | 0)) {
     xe(62026) | 0;
     continue;
    }
    if ((a[c[m >> 2] >> 0] | 0) != 100) continue;
    c[m >> 2] = (c[m >> 2] | 0) + 1;
    if (d[1092356 + ((c[18880] | 0) - 1) >> 0] | 0) continue;
    c[z >> 2] = c[75660 + ((c[18880] | 0) - 1 << 2) >> 2];
    Dd(h, 62053, z) | 0;
    f = $d(bb((Zd(h) | 0) + 1 | 0) | 0, h) | 0;
    c[75916 + ((c[18880] | 0) - 1 << 2) >> 2] = f;
   }
   while (1) {
    if ((c[18881] | 0) == (c[18879] | 0)) break;
    zc();
   }
   if ((c[18880] | 0) != (c[18878] | 0)) {
    c[18880] = (c[18880] | 0) + -1;
    c[(c[p >> 2] | 0) + 16 >> 2] = c[75660 + (c[18880] << 2) >> 2];
    a[(c[p >> 2] | 0) + 12 >> 0] = a[1092356 + (c[18880] | 0) >> 0] | 0;
    A = c[75916 + (c[18880] << 2) >> 2] | 0;
    c[(c[p >> 2] | 0) + 8 >> 2] = A;
    if (A | 0) {
     A = (c[p >> 2] | 0) + 12 | 0;
     a[A >> 0] = d[A >> 0] | 8;
     if (a[1092353] & 1) {
      c[x >> 2] = c[(c[p >> 2] | 0) + 8 >> 2];
      ve(62057, x) | 0;
     }
    }
    if (!(d[(c[o >> 2] | 0) + 13 >> 0] | 0)) a[(c[o >> 2] | 0) + 13 >> 0] = 3;
   }
   if ((c[18880] | 0) == (c[18878] | 0)) if ((c[18881] | 0) == (c[18879] | 0)) {
    A = c[18878] | 0;
    c[18880] = A;
    A = c[18879] | 0;
    c[18881] = A;
    A = c[q >> 2] | 0;
    c[18878] = A;
    A = c[r >> 2] | 0;
    c[18879] = A;
    A = c[o >> 2] | 0;
    i = B;
    return A | 0;
   }
   Ya(5, 0, c[t >> 2] | 0) | 0;
   A = c[18878] | 0;
   c[18880] = A;
   A = c[18879] | 0;
   c[18881] = A;
   A = c[q >> 2] | 0;
   c[18878] = A;
   A = c[r >> 2] | 0;
   c[18879] = A;
   A = c[o >> 2] | 0;
   i = B;
   return A | 0;
  }

  function db(b, e, f) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0, C = 0, D = 0, E = 0, F = 0, G = 0, H = 0, I = 0, J = 0, K = 0;
   K = i;
   i = i + 1248 | 0;
   H = K + 80 | 0;
   G = K + 72 | 0;
   F = K + 64 | 0;
   E = K + 56 | 0;
   D = K + 48 | 0;
   C = K + 40 | 0;
   B = K + 32 | 0;
   A = K + 24 | 0;
   z = K + 16 | 0;
   I = K + 8 | 0;
   y = K;
   r = K + 136 | 0;
   s = K + 132 | 0;
   t = K + 128 | 0;
   u = K + 124 | 0;
   v = K + 120 | 0;
   w = K + 1232 | 0;
   x = K + 208 | 0;
   g = K + 116 | 0;
   h = K + 112 | 0;
   j = K + 108 | 0;
   k = K + 104 | 0;
   l = K + 100 | 0;
   m = K + 96 | 0;
   n = K + 92 | 0;
   o = K + 88 | 0;
   p = K + 84 | 0;
   q = K + 144 | 0;
   c[s >> 2] = b;
   c[t >> 2] = e;
   c[u >> 2] = f;
   c[v >> 2] = 0;
   a[w >> 0] = 0;
   c[j >> 2] = -1;
   c[k >> 2] = 0;
   c[l >> 2] = 0;
   _a(588);
   c[16541] = 1;
   a : do if ((c[s >> 2] | 0) >= 2) {
    c[g >> 2] = 2;
    while (1) {
     if ((c[g >> 2] | 0) >= (c[s >> 2] | 0)) break;
     if ((a[c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] >> 0] | 0) != 45) if ((a[c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] >> 0] | 0) != 47) break a;
     c[m >> 2] = (c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] | 0) + 2;
     b : do switch (a[(c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] | 0) + 1 >> 0] | 0) {
     case 69:
      {
       c[16555] = zd(c[m >> 2] | 0, 0, 10) | 0;
       if ((c[16555] | 0) >>> 0 < 0 | (c[16555] | 0) >>> 0 >= 3) Na(59765);
       break;
      }
     case 84:
      {
       c[16554] = zd(c[m >> 2] | 0, 0, 10) | 0;
       if ((c[16554] | 0) >>> 0 < 0 | (c[16554] | 0) >>> 0 >= 2) Na(59810);
       a[c[u >> 2] >> 0] = (c[16554] | 0) != 0 & 1;
       break;
      }
     case 100:
      {
       a[1092353] = (zd(c[m >> 2] | 0, 0, 10) | 0) != 0 & 1;
       c[y >> 2] = a[1092353] & 1 ? 59861 : 61526;
       ve(59864, y) | 0;
       break;
      }
     case 68:
     case 77:
      {
       while (1) {
        if (a[c[m >> 2] >> 0] | 0) b = (a[c[m >> 2] >> 0] | 0) != 61; else b = 0;
        e = c[m >> 2] | 0;
        if (!b) break;
        c[m >> 2] = e + 1;
       }
       if ((a[e >> 0] | 0) == 61) {
        a[c[m >> 2] >> 0] = 0;
        c[m >> 2] = (c[m >> 2] | 0) + 1;
       } else c[m >> 2] = 59880;
       c[18609] = (c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] | 0) + 2;
       b = c[m >> 2] | 0;
       if ((a[(c[(c[t >> 2] | 0) + (c[g >> 2] << 2) >> 2] | 0) + 1 >> 0] | 0) == 77) {
        Ib(b, 0);
        break b;
       } else {
        Kb(b, 0);
        break b;
       }
      }
     case 102:
      {
       c[111] = zd(c[m >> 2] | 0, 0, 10) | 0;
       if ((c[111] | 0) < 1 | (c[111] | 0) >= 4) Na(59882);
       break;
      }
     case 111:
      {
       c[112] = c[m >> 2];
       J = 27;
       break;
      }
     case 76:
      {
       a[76921] = 1;
       J = 30;
       break;
      }
     case 108:
      {
       J = 30;
       break;
      }
     case 80:
      {
       a[w >> 0] = 1;
       J = 32;
       break;
      }
     case 112:
      {
       J = 32;
       break;
      }
     case 115:
      {
       c[18873] = c[m >> 2];
       J = 27;
       break;
      }
     case 118:
      {
       a[1092354] = zd(c[m >> 2] | 0, 0, 10) | 0;
       break;
      }
     case 73:
      {
       Xb(c[m >> 2] | 0, 0);
       break;
      }
     default:
      break a;
     } while (0);
     if ((J | 0) == 30) {
      c[18872] = c[m >> 2];
      J = 27;
     } else if ((J | 0) == 32) {
      J = 0;
      c[110] = zd(c[m >> 2] | 0, 0, 10) | 0;
     }
     if ((J | 0) == 27) {
      J = 0;
      if (!(a[c[m >> 2] >> 0] | 0)) Na(59911);
     }
     c[g >> 2] = (c[g >> 2] | 0) + 1;
    }
    c[n >> 2] = Wa(32) | 0;
    y = $d(Wa(21) | 0, 59941) | 0;
    c[(c[n >> 2] | 0) + 4 >> 2] = y;
    a[(c[n >> 2] | 0) + 29 >> 0] = 1;
    a[(c[n >> 2] | 0) + 28 >> 0] = 1;
    a[(c[n >> 2] | 0) + 9 >> 0] = 1;
    a[(c[n >> 2] | 0) + 8 >> 0] = 1;
    y = c[n >> 2] | 0;
    c[18606] = y;
    c[18607] = y;
    c[o >> 2] = ab(12) | 0;
    c[(c[o >> 2] | 0) + 4 >> 2] = 0;
    a[(c[o >> 2] | 0) + 8 >> 0] = 4;
    a[(c[o >> 2] | 0) + 10 >> 0] = 1;
    a[(c[o >> 2] | 0) + 9 >> 0] = 1;
    c[18608] = c[o >> 2];
    a[89462] = 0;
    a[76922] = 0;
    while (1) {
     if (a[1092354] | 0) {
      xe(87961) | 0;
      c[I >> 2] = c[16541];
      ve(59962, I) | 0;
     }
     c[18868] = 0;
     c[18867] = 0;
     c[18870] = 0;
     c[18869] = 0;
     c[18875] = de(c[112] | 0, 59981) | 0;
     a[1092355] = 1;
     c[18871] = 0;
     if (!(c[18875] | 0)) {
      J = 41;
      break;
     }
     if (c[18872] | 0) {
      c[18874] = de(c[18872] | 0, (d[76921] | 0 ? (c[16541] | 0) > 1 : 0) ? 63415 : 63458) | 0;
      if (!(c[18874] | 0)) {
       J = 44;
       break;
      }
     }
     $a(c[(c[t >> 2] | 0) + 4 >> 2] | 0);
     while (1) {
      if (!(c[18604] | 0)) break;
      c : while (1) {
       do if (d[(c[18604] | 0) + 16 >> 0] & 1 | 0) if (!(c[(c[18604] | 0) + 24 >> 2] | 0)) {
        c[18609] = 87961;
        Ob(0, 0);
        continue c;
       } else {
        $d(x, (c[(c[18604] | 0) + 24 >> 2] | 0) + 4 | 0) | 0;
        c[(c[18604] | 0) + 24 >> 2] = c[c[(c[18604] | 0) + 24 >> 2] >> 2];
        break;
       } else if (!(je(x, 1024, c[(c[18604] | 0) + 8 >> 2] | 0) | 0)) break c; while (0);
       if (a[1092353] & 1) {
        c[B >> 2] = c[18604];
        c[B + 4 >> 2] = x;
        ve(57994, B) | 0;
       }
       c[p >> 2] = Xa(x, 0) | 0;
       y = (c[18604] | 0) + 12 | 0;
       c[y >> 2] = (c[y >> 2] | 0) + 1;
       c[h >> 2] = Qa(x) | 0;
       do if (a[c[18610] >> 0] | 0) {
        if (!(c[h >> 2] | 0)) {
         if (!(d[(c[18608] | 0) + 9 >> 0] | 0)) break;
         if (!(d[(c[18608] | 0) + 10 >> 0] | 0)) break;
         Ya(9, 0, c[18610] | 0) | 0;
         break;
        }
        if (!(d[(c[h >> 2] | 0) + 12 >> 0] & 4)) {
         if (!(d[(c[18608] | 0) + 9 >> 0] | 0)) break;
         if (!(d[(c[18608] | 0) + 10 >> 0] | 0)) break;
        }
        ya[c[(c[h >> 2] | 0) + 4 >> 2] & 63](c[18611] | 0, c[h >> 2] | 0);
       } else if (d[(c[18608] | 0) + 9 >> 0] | 0) if (d[(c[18608] | 0) + 10 >> 0] | 0) Mc(); while (0);
       if (!(c[18872] | 0)) continue;
       if (!(a[61801] | 0)) continue;
       Va(c[p >> 2] | 0);
      }
      while (1) {
       if (!(c[18605] | 0)) break;
       if ((c[(c[18605] | 0) + 16 >> 2] | 0) != (c[18604] | 0)) break;
       Pa(74420, 24);
      }
      while (1) {
       if ((c[(c[18608] | 0) + 4 >> 2] | 0) != (c[18604] | 0)) break;
       Pa(74432, 12);
      }
      ge(c[(c[18604] | 0) + 8 >> 2] | 0) | 0;
      Ae(c[(c[18604] | 0) + 4 >> 2] | 0);
      a[1092352] = (a[1092352] | 0) + -1 << 24 >> 24;
      Pa(74416, 36);
      if (!((c[18604] | 0) != 0 & (c[18872] | 0) != 0)) continue;
      y = c[18874] | 0;
      c[C >> 2] = c[(c[18604] | 0) + 4 >> 2];
      le(y, 60018, C) | 0;
     }
     if ((d[1092354] | 0) >= 1) ib();
     if ((d[1092354] | 0) >= 3) {
      if (c[16552] | 0) {
       if ((d[1092354] | 0) == 4) J = 81;
      } else J = 81;
      if ((J | 0) == 81) {
       J = 0;
       fb(c[14187] | 0, a[c[u >> 2] >> 0] & 1);
      }
      jb() | 0;
     }
     Yb();
     ge(c[18875] | 0) | 0;
     if (c[18874] | 0) ge(c[18874] | 0) | 0;
     if (!(c[16552] | 0)) break;
     if (!(a[w >> 0] & 1)) if ((c[16552] | 0) == (c[j >> 2] | 0)) if ((c[16550] | 0) == (c[k >> 2] | 0)) if ((c[16551] | 0) == (c[l >> 2] | 0)) {
      J = 90;
      break;
     }
     c[j >> 2] = c[16552];
     c[k >> 2] = c[16550];
     c[l >> 2] = c[16551];
     c[16552] = 0;
     c[16550] = 0;
     c[16551] = 0;
     c[16553] = c[16553] << 1;
     c[16541] = (c[16541] | 0) + 1;
     if (a[76920] & 1) {
      J = 92;
      break;
     }
     if ((c[16541] | 0) > (c[110] | 0)) {
      J = 94;
      break;
     }
     a[89462] = 0;
     a[76922] = 0;
     Ma();
     La();
    }
    if ((J | 0) == 41) {
     c[z >> 2] = c[112];
     ve(59984, z) | 0;
     c[r >> 2] = 2;
     J = c[r >> 2] | 0;
     i = K;
     return J | 0;
    } else if ((J | 0) == 44) {
     c[A >> 2] = c[18872];
     ve(59984, A) | 0;
     c[r >> 2] = 2;
     J = c[r >> 2] | 0;
     i = K;
     return J | 0;
    } else if ((J | 0) == 90) {
     jb() | 0;
     c[r >> 2] = 3;
     J = c[r >> 2] | 0;
     i = K;
     return J | 0;
    } else if ((J | 0) == 92) {
     c[D >> 2] = 89462;
     ve(58110, D) | 0;
     ve(60035, E) | 0;
    } else if ((J | 0) == 94) {
     c[F >> 2] = c[16541];
     Dd(q, 63460, F) | 0;
     c[r >> 2] = Ya(4, 0, q) | 0;
     J = c[r >> 2] | 0;
     i = K;
     return J | 0;
    }
    if (!(a[76920] & 1)) {
     a[76922] = 32;
     c[G >> 2] = 76922;
     ve(58110, G) | 0;
    }
    ve(60087, H) | 0;
    c[r >> 2] = c[v >> 2];
    J = c[r >> 2] | 0;
    i = K;
    return J | 0;
   } while (0);
   xe(58671) | 0;
   xe(58693) | 0;
   xe(58756) | 0;
   xe(58819) | 0;
   xe(58886) | 0;
   xe(87961) | 0;
   xe(58951) | 0;
   xe(87961) | 0;
   xe(58984) | 0;
   xe(59023) | 0;
   xe(59062) | 0;
   xe(59108) | 0;
   xe(59150) | 0;
   xe(59203) | 0;
   xe(59240) | 0;
   xe(59277) | 0;
   xe(59323) | 0;
   xe(59378) | 0;
   xe(59437) | 0;
   xe(59486) | 0;
   xe(59520) | 0;
   xe(59573) | 0;
   xe(59649) | 0;
   xe(87961) | 0;
   xe(59709) | 0;
   c[r >> 2] = 1;
   J = c[r >> 2] | 0;
   i = K;
   return J | 0;
  }

  function Ae(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0;
   if (!a) return;
   d = a + -8 | 0;
   h = c[19110] | 0;
   if (d >>> 0 < h >>> 0) ia();
   a = c[a + -4 >> 2] | 0;
   b = a & 3;
   if ((b | 0) == 1) ia();
   e = a & -8;
   n = d + e | 0;
   do if (!(a & 1)) {
    a = c[d >> 2] | 0;
    if (!b) return;
    k = d + (0 - a) | 0;
    j = a + e | 0;
    if (k >>> 0 < h >>> 0) ia();
    if ((k | 0) == (c[19111] | 0)) {
     a = n + 4 | 0;
     b = c[a >> 2] | 0;
     if ((b & 3 | 0) != 3) {
      q = k;
      f = j;
      break;
     }
     c[19108] = j;
     c[a >> 2] = b & -2;
     c[k + 4 >> 2] = j | 1;
     c[k + j >> 2] = j;
     return;
    }
    e = a >>> 3;
    if (a >>> 0 < 256) {
     b = c[k + 8 >> 2] | 0;
     d = c[k + 12 >> 2] | 0;
     a = 76464 + (e << 1 << 2) | 0;
     if ((b | 0) != (a | 0)) {
      if (b >>> 0 < h >>> 0) ia();
      if ((c[b + 12 >> 2] | 0) != (k | 0)) ia();
     }
     if ((d | 0) == (b | 0)) {
      c[19106] = c[19106] & ~(1 << e);
      q = k;
      f = j;
      break;
     }
     if ((d | 0) == (a | 0)) g = d + 8 | 0; else {
      if (d >>> 0 < h >>> 0) ia();
      a = d + 8 | 0;
      if ((c[a >> 2] | 0) == (k | 0)) g = a; else ia();
     }
     c[b + 12 >> 2] = d;
     c[g >> 2] = b;
     q = k;
     f = j;
     break;
    }
    g = c[k + 24 >> 2] | 0;
    d = c[k + 12 >> 2] | 0;
    do if ((d | 0) == (k | 0)) {
     d = k + 16 | 0;
     b = d + 4 | 0;
     a = c[b >> 2] | 0;
     if (!a) {
      a = c[d >> 2] | 0;
      if (!a) {
       i = 0;
       break;
      } else b = d;
     }
     while (1) {
      d = a + 20 | 0;
      e = c[d >> 2] | 0;
      if (e | 0) {
       a = e;
       b = d;
       continue;
      }
      d = a + 16 | 0;
      e = c[d >> 2] | 0;
      if (!e) break; else {
       a = e;
       b = d;
      }
     }
     if (b >>> 0 < h >>> 0) ia(); else {
      c[b >> 2] = 0;
      i = a;
      break;
     }
    } else {
     e = c[k + 8 >> 2] | 0;
     if (e >>> 0 < h >>> 0) ia();
     a = e + 12 | 0;
     if ((c[a >> 2] | 0) != (k | 0)) ia();
     b = d + 8 | 0;
     if ((c[b >> 2] | 0) == (k | 0)) {
      c[a >> 2] = d;
      c[b >> 2] = e;
      i = d;
      break;
     } else ia();
    } while (0);
    if (!g) {
     q = k;
     f = j;
    } else {
     a = c[k + 28 >> 2] | 0;
     b = 76728 + (a << 2) | 0;
     if ((k | 0) == (c[b >> 2] | 0)) {
      c[b >> 2] = i;
      if (!i) {
       c[19107] = c[19107] & ~(1 << a);
       q = k;
       f = j;
       break;
      }
     } else {
      if (g >>> 0 < (c[19110] | 0) >>> 0) ia();
      a = g + 16 | 0;
      if ((c[a >> 2] | 0) == (k | 0)) c[a >> 2] = i; else c[g + 20 >> 2] = i;
      if (!i) {
       q = k;
       f = j;
       break;
      }
     }
     d = c[19110] | 0;
     if (i >>> 0 < d >>> 0) ia();
     c[i + 24 >> 2] = g;
     a = k + 16 | 0;
     b = c[a >> 2] | 0;
     do if (b | 0) if (b >>> 0 < d >>> 0) ia(); else {
      c[i + 16 >> 2] = b;
      c[b + 24 >> 2] = i;
      break;
     } while (0);
     a = c[a + 4 >> 2] | 0;
     if (!a) {
      q = k;
      f = j;
     } else if (a >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
      c[i + 20 >> 2] = a;
      c[a + 24 >> 2] = i;
      q = k;
      f = j;
      break;
     }
    }
   } else {
    q = d;
    f = e;
   } while (0);
   if (q >>> 0 >= n >>> 0) ia();
   a = n + 4 | 0;
   b = c[a >> 2] | 0;
   if (!(b & 1)) ia();
   if (!(b & 2)) {
    if ((n | 0) == (c[19112] | 0)) {
     p = (c[19109] | 0) + f | 0;
     c[19109] = p;
     c[19112] = q;
     c[q + 4 >> 2] = p | 1;
     if ((q | 0) != (c[19111] | 0)) return;
     c[19111] = 0;
     c[19108] = 0;
     return;
    }
    if ((n | 0) == (c[19111] | 0)) {
     p = (c[19108] | 0) + f | 0;
     c[19108] = p;
     c[19111] = q;
     c[q + 4 >> 2] = p | 1;
     c[q + p >> 2] = p;
     return;
    }
    f = (b & -8) + f | 0;
    e = b >>> 3;
    do if (b >>> 0 < 256) {
     b = c[n + 8 >> 2] | 0;
     d = c[n + 12 >> 2] | 0;
     a = 76464 + (e << 1 << 2) | 0;
     if ((b | 0) != (a | 0)) {
      if (b >>> 0 < (c[19110] | 0) >>> 0) ia();
      if ((c[b + 12 >> 2] | 0) != (n | 0)) ia();
     }
     if ((d | 0) == (b | 0)) {
      c[19106] = c[19106] & ~(1 << e);
      break;
     }
     if ((d | 0) == (a | 0)) l = d + 8 | 0; else {
      if (d >>> 0 < (c[19110] | 0) >>> 0) ia();
      a = d + 8 | 0;
      if ((c[a >> 2] | 0) == (n | 0)) l = a; else ia();
     }
     c[b + 12 >> 2] = d;
     c[l >> 2] = b;
    } else {
     g = c[n + 24 >> 2] | 0;
     a = c[n + 12 >> 2] | 0;
     do if ((a | 0) == (n | 0)) {
      d = n + 16 | 0;
      b = d + 4 | 0;
      a = c[b >> 2] | 0;
      if (!a) {
       a = c[d >> 2] | 0;
       if (!a) {
        m = 0;
        break;
       } else b = d;
      }
      while (1) {
       d = a + 20 | 0;
       e = c[d >> 2] | 0;
       if (e | 0) {
        a = e;
        b = d;
        continue;
       }
       d = a + 16 | 0;
       e = c[d >> 2] | 0;
       if (!e) break; else {
        a = e;
        b = d;
       }
      }
      if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
       c[b >> 2] = 0;
       m = a;
       break;
      }
     } else {
      b = c[n + 8 >> 2] | 0;
      if (b >>> 0 < (c[19110] | 0) >>> 0) ia();
      d = b + 12 | 0;
      if ((c[d >> 2] | 0) != (n | 0)) ia();
      e = a + 8 | 0;
      if ((c[e >> 2] | 0) == (n | 0)) {
       c[d >> 2] = a;
       c[e >> 2] = b;
       m = a;
       break;
      } else ia();
     } while (0);
     if (g | 0) {
      a = c[n + 28 >> 2] | 0;
      b = 76728 + (a << 2) | 0;
      if ((n | 0) == (c[b >> 2] | 0)) {
       c[b >> 2] = m;
       if (!m) {
        c[19107] = c[19107] & ~(1 << a);
        break;
       }
      } else {
       if (g >>> 0 < (c[19110] | 0) >>> 0) ia();
       a = g + 16 | 0;
       if ((c[a >> 2] | 0) == (n | 0)) c[a >> 2] = m; else c[g + 20 >> 2] = m;
       if (!m) break;
      }
      d = c[19110] | 0;
      if (m >>> 0 < d >>> 0) ia();
      c[m + 24 >> 2] = g;
      a = n + 16 | 0;
      b = c[a >> 2] | 0;
      do if (b | 0) if (b >>> 0 < d >>> 0) ia(); else {
       c[m + 16 >> 2] = b;
       c[b + 24 >> 2] = m;
       break;
      } while (0);
      a = c[a + 4 >> 2] | 0;
      if (a | 0) if (a >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
       c[m + 20 >> 2] = a;
       c[a + 24 >> 2] = m;
       break;
      }
     }
    } while (0);
    c[q + 4 >> 2] = f | 1;
    c[q + f >> 2] = f;
    if ((q | 0) == (c[19111] | 0)) {
     c[19108] = f;
     return;
    }
   } else {
    c[a >> 2] = b & -2;
    c[q + 4 >> 2] = f | 1;
    c[q + f >> 2] = f;
   }
   a = f >>> 3;
   if (f >>> 0 < 256) {
    d = 76464 + (a << 1 << 2) | 0;
    b = c[19106] | 0;
    a = 1 << a;
    if (!(b & a)) {
     c[19106] = b | a;
     o = d;
     p = d + 8 | 0;
    } else {
     a = d + 8 | 0;
     b = c[a >> 2] | 0;
     if (b >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
      o = b;
      p = a;
     }
    }
    c[p >> 2] = q;
    c[o + 12 >> 2] = q;
    c[q + 8 >> 2] = o;
    c[q + 12 >> 2] = d;
    return;
   }
   a = f >>> 8;
   if (!a) a = 0; else if (f >>> 0 > 16777215) a = 31; else {
    o = (a + 1048320 | 0) >>> 16 & 8;
    p = a << o;
    n = (p + 520192 | 0) >>> 16 & 4;
    p = p << n;
    a = (p + 245760 | 0) >>> 16 & 2;
    a = 14 - (n | o | a) + (p << a >>> 15) | 0;
    a = f >>> (a + 7 | 0) & 1 | a << 1;
   }
   e = 76728 + (a << 2) | 0;
   c[q + 28 >> 2] = a;
   c[q + 20 >> 2] = 0;
   c[q + 16 >> 2] = 0;
   b = c[19107] | 0;
   d = 1 << a;
   do if (!(b & d)) {
    c[19107] = b | d;
    c[e >> 2] = q;
    c[q + 24 >> 2] = e;
    c[q + 12 >> 2] = q;
    c[q + 8 >> 2] = q;
   } else {
    b = f << ((a | 0) == 31 ? 0 : 25 - (a >>> 1) | 0);
    e = c[e >> 2] | 0;
    while (1) {
     if ((c[e + 4 >> 2] & -8 | 0) == (f | 0)) {
      a = 130;
      break;
     }
     d = e + 16 + (b >>> 31 << 2) | 0;
     a = c[d >> 2] | 0;
     if (!a) {
      a = 127;
      break;
     } else {
      b = b << 1;
      e = a;
     }
    }
    if ((a | 0) == 127) if (d >>> 0 < (c[19110] | 0) >>> 0) ia(); else {
     c[d >> 2] = q;
     c[q + 24 >> 2] = e;
     c[q + 12 >> 2] = q;
     c[q + 8 >> 2] = q;
     break;
    } else if ((a | 0) == 130) {
     a = e + 8 | 0;
     b = c[a >> 2] | 0;
     p = c[19110] | 0;
     if (b >>> 0 >= p >>> 0 & e >>> 0 >= p >>> 0) {
      c[b + 12 >> 2] = q;
      c[a >> 2] = q;
      c[q + 8 >> 2] = b;
      c[q + 12 >> 2] = e;
      c[q + 24 >> 2] = 0;
      break;
     } else ia();
    }
   } while (0);
   q = (c[19114] | 0) + -1 | 0;
   c[19114] = q;
   if (!q) a = 76880; else return;
   while (1) {
    a = c[a >> 2] | 0;
    if (!a) break; else a = a + 8 | 0;
   }
   c[19114] = -1;
   return;
  }

  function mb(e, f) {
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0, C = 0;
   C = i;
   i = i + 432 | 0;
   B = C + 56 | 0;
   n = C + 48 | 0;
   m = C + 40 | 0;
   l = C + 32 | 0;
   o = C + 16 | 0;
   k = C;
   q = C + 92 | 0;
   s = C + 88 | 0;
   t = C + 84 | 0;
   y = C + 80 | 0;
   r = C + 76 | 0;
   z = C + 96 | 0;
   A = C + 72 | 0;
   j = C + 68 | 0;
   g = C + 304 | 0;
   h = C + 176 | 0;
   u = C + 64 | 0;
   v = C + 168 | 0;
   w = C + 60 | 0;
   x = C + 104 | 0;
   c[q >> 2] = e;
   c[s >> 2] = f;
   f = (c[18607] | 0) + 8 | 0;
   a[f >> 0] = d[f >> 0] | 4;
   Mc();
   c[A >> 2] = Zb(c[q >> 2] | 0, 1) | 0;
   if (a[1091839] & 1) {
    e = c[(c[s >> 2] | 0) + 8 >> 2] | 0;
    f = d[(c[A >> 2] | 0) + 13 >> 0] | 0;
    c[k >> 2] = c[(c[18607] | 0) + 12 >> 2];
    c[k + 4 >> 2] = e;
    c[k + 8 >> 2] = f;
    ve(61311, k) | 0;
   }
   c[y >> 2] = c[A >> 2];
   while (1) {
    if (!(c[y >> 2] | 0)) break;
    if (d[(c[y >> 2] | 0) + 12 >> 0] & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 1;
    }
    c[y >> 2] = c[c[y >> 2] >> 2];
   }
   c[y >> 2] = c[A >> 2];
   if (d[(c[s >> 2] | 0) + 12 >> 0] & 64 | 0) if (c[c[y >> 2] >> 2] | 0) {
    a[(c[y >> 2] | 0) + 13 >> 0] = 15;
    if (d[(c[s >> 2] | 0) + 12 >> 0] & 32 | 0) if (c[c[y >> 2] >> 2] | 0) a[(c[y >> 2] | 0) + 13 >> 0] = 16;
   }
   c[t >> 2] = d[(c[y >> 2] | 0) + 13 >> 0];
   if (d[(c[y >> 2] | 0) + 12 >> 0] & 1 | 0) p = 15; else if ((c[(c[y >> 2] | 0) + 16 >> 2] | 0) >= 256) p = 15; else c[j >> 2] = c[(c[y >> 2] | 0) + 16 >> 2] | 0 ? 1 : 0;
   if ((p | 0) == 15) c[j >> 2] = 2;
   while (1) {
    if (c[(c[s >> 2] | 0) + 16 >> 2] & 1 << c[t >> 2] | 0) break;
    if (!(c[452 + (c[t >> 2] << 2) >> 2] | 0)) break;
    c[t >> 2] = c[452 + (c[t >> 2] << 2) >> 2];
   }
   if (a[1091839] & 1) {
    f = c[t >> 2] | 0;
    k = c[452 + (c[t >> 2] << 2) >> 2] | 0;
    c[o >> 2] = c[(c[s >> 2] | 0) + 16 >> 2];
    c[o + 4 >> 2] = f;
    c[o + 8 >> 2] = k;
    ve(61351, o) | 0;
   }
   if (!(c[(c[s >> 2] | 0) + 16 >> 2] & 1 << c[t >> 2])) {
    B = c[q >> 2] | 0;
    c[l >> 2] = c[(c[s >> 2] | 0) + 8 >> 2];
    c[l + 4 >> 2] = B;
    Dd(g, 62283, l) | 0;
    Ya(10, 0, g) | 0;
    Nc(c[A >> 2] | 0);
    c[16552] = (c[16552] | 0) + 1;
    c[16550] = c[16550] | 1;
    i = C;
    return;
   }
   if ((c[18865] | 0) >= 0 & (c[18865] | 0) < 21) {
    c[t >> 2] = c[18865];
    if (!(c[(c[s >> 2] | 0) + 16 >> 2] & 1 << c[t >> 2])) {
     Ya(11, 0, c[(c[s >> 2] | 0) + 8 >> 2] | 0) | 0;
     Nc(c[A >> 2] | 0);
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 1;
     i = C;
     return;
    }
   }
   if (a[1091839] & 1) {
    c[m >> 2] = c[t >> 2];
    ve(61392, m) | 0;
   }
   while (1) {
    if ((c[j >> 2] | 0) >>> 0 <= (c[520 + (c[t >> 2] << 2) >> 2] | 0) >>> 0) break;
    if (!(c[452 + (c[t >> 2] << 2) >> 2] | 0)) {
     p = 32;
     break;
    }
    if (!(c[(c[s >> 2] | 0) + 16 >> 2] & 1 << c[452 + (c[t >> 2] << 2) >> 2])) {
     p = 32;
     break;
    }
    c[t >> 2] = c[452 + (c[t >> 2] << 2) >> 2];
   }
   do if ((p | 0) == 32) if (!(d[(c[y >> 2] | 0) + 12 >> 0] & 1)) {
    if ((c[t >> 2] | 0) == 1) if ((c[(c[y >> 2] | 0) + 16 >> 2] | 0) < 0) {
     c[j >> 2] = 1;
     c[(c[y >> 2] | 0) + 16 >> 2] = (c[(c[y >> 2] | 0) + 16 >> 2] & 255) << 24 >> 24;
     break;
    }
    p = c[q >> 2] | 0;
    c[n >> 2] = c[(c[s >> 2] | 0) + 8 >> 2];
    c[n + 4 >> 2] = p;
    Dd(h, 62283, n) | 0;
    Ya(19, 0, h) | 0;
   } while (0);
   c[r >> 2] = c[(c[s >> 2] | 0) + 20 + (c[t >> 2] << 2) >> 2];
   b[z >> 1] = 1 + ((c[r >> 2] | 0) >>> 0 > 255 & 1);
   e = c[r >> 2] | 0;
   if ((b[z >> 1] | 0) == 2) {
    a[1091574] = e >>> 8;
    a[1091575] = c[r >> 2];
   } else a[1091574] = e;
   a : do switch (c[t >> 2] | 0) {
   case 15:
    {
     c[y >> 2] = c[c[A >> 2] >> 2];
     if (!(d[(c[y >> 2] | 0) + 12 >> 0] & 1)) if ((c[(c[y >> 2] | 0) + 16 >> 2] | 0) >= 256) Ya(19, 0, 0) | 0;
     p = c[(c[y >> 2] | 0) + 16 >> 2] & 255;
     r = b[z >> 1] | 0;
     b[z >> 1] = r + 1 << 16 >> 16;
     a[1091574 + (r << 16 >> 16) >> 0] = p;
     if (!(d[(c[A >> 2] | 0) + 12 >> 0] & 1)) if ((c[(c[A >> 2] | 0) + 16 >> 2] | 0) > 7) {
      Ya(20, 0, c[q >> 2] | 0) | 0;
      break a;
     } else {
      a[1091574] = (d[1091574] | 0) + (c[(c[A >> 2] | 0) + 16 >> 2] << 1);
      break a;
     }
     break;
    }
   case 16:
    {
     do if (!(d[(c[A >> 2] | 0) + 12 >> 0] & 1)) if ((c[(c[A >> 2] | 0) + 16 >> 2] | 0) > 7) {
      Ya(20, 0, c[q >> 2] | 0) | 0;
      break;
     } else {
      a[1091574] = (d[1091574] | 0) + (c[(c[A >> 2] | 0) + 16 >> 2] << 1);
      break;
     } while (0);
     c[y >> 2] = c[c[A >> 2] >> 2];
     if (!(d[(c[y >> 2] | 0) + 12 >> 0] & 1)) if ((c[(c[y >> 2] | 0) + 16 >> 2] | 0) >= 256) Ya(19, 0, 0) | 0;
     q = c[(c[y >> 2] | 0) + 16 >> 2] & 255;
     r = b[z >> 1] | 0;
     b[z >> 1] = r + 1 << 16 >> 16;
     a[1091574 + (r << 16 >> 16) >> 0] = q;
     c[y >> 2] = c[c[y >> 2] >> 2];
     break;
    }
   case 9:
    break;
   default:
    {
     if ((c[520 + (c[t >> 2] << 2) >> 2] | 0) >>> 0 > 0) {
      q = c[(c[y >> 2] | 0) + 16 >> 2] & 255;
      r = b[z >> 1] | 0;
      b[z >> 1] = r + 1 << 16 >> 16;
      a[1091574 + (r << 16 >> 16) >> 0] = q;
     }
     do if ((c[520 + (c[t >> 2] << 2) >> 2] | 0) == 2) {
      e = c[(c[y >> 2] | 0) + 16 >> 2] >> 8 & 255;
      f = b[z >> 1] | 0;
      if (a[61800] | 0) {
       a[1091574 + ((f << 16 >> 16) - 1) >> 0] = e;
       q = c[(c[y >> 2] | 0) + 16 >> 2] & 255;
       r = b[z >> 1] | 0;
       b[z >> 1] = r + 1 << 16 >> 16;
       a[1091574 + (r << 16 >> 16) >> 0] = q;
       break;
      } else {
       b[z >> 1] = f + 1 << 16 >> 16;
       a[1091574 + (f << 16 >> 16) >> 0] = e;
       break;
      }
     } while (0);
     c[y >> 2] = c[c[y >> 2] >> 2];
    }
   } while (0);
   if (d[(c[s >> 2] | 0) + 12 >> 0] & 16 | 0) {
    if (c[y >> 2] | 0) {
     if (!(d[(c[y >> 2] | 0) + 12 >> 0] & 1)) if ((c[(c[y >> 2] | 0) + 16 >> 2] | 0) >= 256) Ya(19, 0, 0) | 0;
     a[1091574 + (b[z >> 1] | 0) >> 0] = c[(c[y >> 2] | 0) + 16 >> 2];
     c[y >> 2] = c[c[y >> 2] >> 2];
    } else Ya(21, 1, 0) | 0;
    b[z >> 1] = (b[z >> 1] | 0) + 1 << 16 >> 16;
   }
   do if ((c[t >> 2] | 0) == 9 ? 1 : (d[(c[s >> 2] | 0) + 12 >> 0] & 32 | 0) != 0) {
    b[z >> 1] = (b[z >> 1] | 0) + 1 << 16 >> 16;
    if (!(c[y >> 2] | 0)) {
     Ya(21, 1, 0) | 0;
     break;
    }
    if (!(d[(c[y >> 2] | 0) + 12 >> 0] & 1)) {
     e = c[18607] | 0;
     if (d[(c[18607] | 0) + 8 >> 0] & 32 | 0) e = c[e + 16 >> 2] | 0; else e = c[e + 12 >> 2] | 0;
     c[u >> 2] = e;
     e = c[18607] | 0;
     if (d[(c[18607] | 0) + 8 >> 0] & 32 | 0) e = a[e + 9 >> 0] | 0; else e = a[e + 8 >> 0] | 0;
     a[v >> 0] = e;
     if (!(d[v >> 0] & 3)) {
      c[w >> 2] = (c[(c[y >> 2] | 0) + 16 >> 2] | 0) - (c[u >> 2] | 0) - (b[z >> 1] | 0);
      if ((c[w >> 2] | 0) >= 128 | (c[w >> 2] | 0) < -128) {
       c[B >> 2] = c[w >> 2];
       Dd(x, 62053, B) | 0;
       Ya(15, 0, x) | 0;
       c[16552] = (c[16552] | 0) + 1;
       c[16550] = c[16550] | 32768;
       a[(c[y >> 2] | 0) + 12 >> 0] = d[(c[y >> 2] | 0) + 12 >> 0] | 1;
       c[w >> 2] = 0;
      }
     } else c[w >> 2] = 0;
     a[1091574 + ((b[z >> 1] | 0) - 1) >> 0] = c[w >> 2];
    }
   } while (0);
   c[16544] = b[z >> 1];
   nb();
   Nc(c[A >> 2] | 0);
   i = C;
   return;
  }

  function ud(b, e, f, g, h) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   g = g | 0;
   h = h | 0;
   var i = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0;
   a : do if (e >>> 0 > 36) {
    c[(kd() | 0) >> 2] = 22;
    h = 0;
    g = 0;
   } else {
    r = b + 4 | 0;
    q = b + 100 | 0;
    do {
     i = c[r >> 2] | 0;
     if (i >>> 0 < (c[q >> 2] | 0) >>> 0) {
      c[r >> 2] = i + 1;
      i = d[i >> 0] | 0;
     } else i = vd(b) | 0;
    } while ((wd(i) | 0) != 0);
    b : do switch (i | 0) {
    case 43:
    case 45:
     {
      i = ((i | 0) == 45) << 31 >> 31;
      j = c[r >> 2] | 0;
      if (j >>> 0 < (c[q >> 2] | 0) >>> 0) {
       c[r >> 2] = j + 1;
       p = i;
       i = d[j >> 0] | 0;
       break b;
      } else {
       p = i;
       i = vd(b) | 0;
       break b;
      }
     }
    default:
     p = 0;
    } while (0);
    j = (e | 0) == 0;
    do if ((e | 16 | 0) == 16 & (i | 0) == 48) {
     i = c[r >> 2] | 0;
     if (i >>> 0 < (c[q >> 2] | 0) >>> 0) {
      c[r >> 2] = i + 1;
      i = d[i >> 0] | 0;
     } else i = vd(b) | 0;
     if ((i | 32 | 0) != 120) if (j) {
      e = 8;
      n = 46;
      break;
     } else {
      n = 32;
      break;
     }
     i = c[r >> 2] | 0;
     if (i >>> 0 < (c[q >> 2] | 0) >>> 0) {
      c[r >> 2] = i + 1;
      i = d[i >> 0] | 0;
     } else i = vd(b) | 0;
     if ((d[63464 + i >> 0] | 0) > 15) {
      g = (c[q >> 2] | 0) == 0;
      if (!g) c[r >> 2] = (c[r >> 2] | 0) + -1;
      if (!f) {
       td(b, 0);
       h = 0;
       g = 0;
       break a;
      }
      if (g) {
       h = 0;
       g = 0;
       break a;
      }
      c[r >> 2] = (c[r >> 2] | 0) + -1;
      h = 0;
      g = 0;
      break a;
     } else {
      e = 16;
      n = 46;
     }
    } else {
     e = j ? 10 : e;
     if ((d[63464 + i >> 0] | 0) >>> 0 < e >>> 0) n = 32; else {
      if (c[q >> 2] | 0) c[r >> 2] = (c[r >> 2] | 0) + -1;
      td(b, 0);
      c[(kd() | 0) >> 2] = 22;
      h = 0;
      g = 0;
      break a;
     }
    } while (0);
    if ((n | 0) == 32) if ((e | 0) == 10) {
     e = i + -48 | 0;
     if (e >>> 0 < 10) {
      i = 0;
      j = e;
      do {
       i = (i * 10 | 0) + j | 0;
       e = c[r >> 2] | 0;
       if (e >>> 0 < (c[q >> 2] | 0) >>> 0) {
        c[r >> 2] = e + 1;
        e = d[e >> 0] | 0;
       } else e = vd(b) | 0;
       j = e + -48 | 0;
      } while (j >>> 0 < 10 & i >>> 0 < 429496729);
      f = 0;
     } else {
      e = i;
      i = 0;
      f = 0;
     }
     j = e + -48 | 0;
     if (j >>> 0 < 10) {
      m = j;
      while (1) {
       j = Le(i | 0, f | 0, 10, 0) | 0;
       k = D;
       l = ((m | 0) < 0) << 31 >> 31;
       o = ~l;
       if (k >>> 0 > o >>> 0 | (k | 0) == (o | 0) & j >>> 0 > ~m >>> 0) {
        j = e;
        e = m;
        break;
       }
       i = De(j | 0, k | 0, m | 0, l | 0) | 0;
       f = D;
       e = c[r >> 2] | 0;
       if (e >>> 0 < (c[q >> 2] | 0) >>> 0) {
        c[r >> 2] = e + 1;
        e = d[e >> 0] | 0;
       } else e = vd(b) | 0;
       k = e + -48 | 0;
       if (k >>> 0 < 10 & (f >>> 0 < 429496729 | (f | 0) == 429496729 & i >>> 0 < 2576980378)) m = k; else {
        j = e;
        e = k;
        break;
       }
      }
      if (e >>> 0 > 9) {
       j = p;
       e = f;
      } else {
       e = 10;
       n = 72;
      }
     } else {
      j = p;
      e = f;
     }
    } else n = 46;
    c : do if ((n | 0) == 46) {
     if (!(e + -1 & e)) {
      n = a[63720 + ((e * 23 | 0) >>> 5 & 7) >> 0] | 0;
      f = a[63464 + i >> 0] | 0;
      j = f & 255;
      if (j >>> 0 < e >>> 0) {
       i = 0;
       k = j;
       do {
        i = k | i << n;
        j = c[r >> 2] | 0;
        if (j >>> 0 < (c[q >> 2] | 0) >>> 0) {
         c[r >> 2] = j + 1;
         j = d[j >> 0] | 0;
        } else j = vd(b) | 0;
        f = a[63464 + j >> 0] | 0;
        k = f & 255;
       } while (i >>> 0 < 134217728 & k >>> 0 < e >>> 0);
       k = 0;
      } else {
       j = i;
       k = 0;
       i = 0;
      }
      l = Fe(-1, -1, n | 0) | 0;
      m = D;
      if ((f & 255) >>> 0 >= e >>> 0 | (k >>> 0 > m >>> 0 | (k | 0) == (m | 0) & i >>> 0 > l >>> 0)) {
       f = k;
       n = 72;
       break;
      } else j = k;
      while (1) {
       i = Ge(i | 0, j | 0, n | 0) | 0;
       k = D;
       i = f & 255 | i;
       j = c[r >> 2] | 0;
       if (j >>> 0 < (c[q >> 2] | 0) >>> 0) {
        c[r >> 2] = j + 1;
        j = d[j >> 0] | 0;
       } else j = vd(b) | 0;
       f = a[63464 + j >> 0] | 0;
       if ((f & 255) >>> 0 >= e >>> 0 | (k >>> 0 > m >>> 0 | (k | 0) == (m | 0) & i >>> 0 > l >>> 0)) {
        f = k;
        n = 72;
        break c;
       } else j = k;
      }
     }
     f = a[63464 + i >> 0] | 0;
     j = f & 255;
     if (j >>> 0 < e >>> 0) {
      i = 0;
      k = j;
      do {
       i = k + (S(i, e) | 0) | 0;
       j = c[r >> 2] | 0;
       if (j >>> 0 < (c[q >> 2] | 0) >>> 0) {
        c[r >> 2] = j + 1;
        j = d[j >> 0] | 0;
       } else j = vd(b) | 0;
       f = a[63464 + j >> 0] | 0;
       k = f & 255;
      } while (i >>> 0 < 119304647 & k >>> 0 < e >>> 0);
      k = 0;
     } else {
      j = i;
      i = 0;
      k = 0;
     }
     if ((f & 255) >>> 0 < e >>> 0) {
      n = Je(-1, -1, e | 0, 0) | 0;
      o = D;
      m = k;
      while (1) {
       if (m >>> 0 > o >>> 0 | (m | 0) == (o | 0) & i >>> 0 > n >>> 0) {
        f = m;
        n = 72;
        break c;
       }
       k = Le(i | 0, m | 0, e | 0, 0) | 0;
       l = D;
       f = f & 255;
       if (l >>> 0 > 4294967295 | (l | 0) == -1 & k >>> 0 > ~f >>> 0) {
        f = m;
        n = 72;
        break c;
       }
       i = De(f | 0, 0, k | 0, l | 0) | 0;
       k = D;
       j = c[r >> 2] | 0;
       if (j >>> 0 < (c[q >> 2] | 0) >>> 0) {
        c[r >> 2] = j + 1;
        j = d[j >> 0] | 0;
       } else j = vd(b) | 0;
       f = a[63464 + j >> 0] | 0;
       if ((f & 255) >>> 0 >= e >>> 0) {
        f = k;
        n = 72;
        break;
       } else m = k;
      }
     } else {
      f = k;
      n = 72;
     }
    } while (0);
    if ((n | 0) == 72) if ((d[63464 + j >> 0] | 0) >>> 0 < e >>> 0) {
     do {
      i = c[r >> 2] | 0;
      if (i >>> 0 < (c[q >> 2] | 0) >>> 0) {
       c[r >> 2] = i + 1;
       i = d[i >> 0] | 0;
      } else i = vd(b) | 0;
     } while ((d[63464 + i >> 0] | 0) >>> 0 < e >>> 0);
     c[(kd() | 0) >> 2] = 34;
     j = (g & 1 | 0) == 0 & 0 == 0 ? p : 0;
     e = h;
     i = g;
    } else {
     j = p;
     e = f;
    }
    if (c[q >> 2] | 0) c[r >> 2] = (c[r >> 2] | 0) + -1;
    if (!(e >>> 0 < h >>> 0 | (e | 0) == (h | 0) & i >>> 0 < g >>> 0)) {
     if (!((g & 1 | 0) != 0 | 0 != 0 | (j | 0) != 0)) {
      c[(kd() | 0) >> 2] = 34;
      g = De(g | 0, h | 0, -1, -1) | 0;
      h = D;
      break;
     }
     if (e >>> 0 > h >>> 0 | (e | 0) == (h | 0) & i >>> 0 > g >>> 0) {
      c[(kd() | 0) >> 2] = 34;
      break;
     }
    }
    g = ((j | 0) < 0) << 31 >> 31;
    g = Ce(i ^ j | 0, e ^ g | 0, j | 0, g | 0) | 0;
    h = D;
   } while (0);
   D = h;
   return g | 0;
  }

  function zb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0;
   p = i;
   i = i + 48 | 0;
   f = p + 28 | 0;
   g = p + 24 | 0;
   k = p + 20 | 0;
   l = p + 16 | 0;
   m = p + 12 | 0;
   n = p + 8 | 0;
   o = p + 32 | 0;
   h = p + 4 | 0;
   j = p;
   c[f >> 2] = b;
   c[g >> 2] = e;
   c[n >> 2] = 0;
   a[o >> 0] = 0;
   c[16544] = 0;
   Mc();
   if ((a[c[(c[g >> 2] | 0) + 8 >> 2] >> 0] | 0) != 100) {
    $d(1091831, 61626) | 0;
    a[1091833] = a[c[(c[g >> 2] | 0) + 8 >> 2] >> 0] | 0;
    Oa(1091831);
   }
   if ((a[c[(c[g >> 2] | 0) + 8 >> 2] >> 0] | 0) == 100) if ((a[(c[(c[g >> 2] | 0) + 8 >> 2] | 0) + 1 >> 0] | 0) != 99) {
    $d(1091835, 61626) | 0;
    if (100 == (a[(c[(c[g >> 2] | 0) + 8 >> 2] | 0) + 1 >> 0] | 0)) a[1091837] = 108; else a[1091837] = a[(c[(c[g >> 2] | 0) + 8 >> 2] | 0) + 1 >> 0] | 0;
    Oa(1091835);
   }
   do if ((a[(c[(c[g >> 2] | 0) + 8 >> 2] | 0) + 1 >> 0] | 0) == 118) {
    a[o >> 0] = 1;
    c[h >> 2] = 0;
    while (1) {
     if (!(a[(c[f >> 2] | 0) + (c[h >> 2] | 0) >> 0] | 0)) break;
     if ((a[(c[f >> 2] | 0) + (c[h >> 2] | 0) >> 0] | 0) == 32) break;
     c[h >> 2] = (c[h >> 2] | 0) + 1;
    }
    c[l >> 2] = Ic(c[f >> 2] | 0, c[h >> 2] | 0) | 0;
    c[f >> 2] = (c[f >> 2] | 0) + (c[h >> 2] | 0);
    if (!(c[l >> 2] | 0)) {
     xe(61630) | 0;
     i = p;
     return;
    }
    if (d[(c[l >> 2] | 0) + 12 >> 0] & 32 | 0) {
     c[n >> 2] = c[(c[l >> 2] | 0) + 8 >> 2];
     break;
    }
    xe(61650) | 0;
    i = p;
    return;
   } while (0);
   c[k >> 2] = Zb(c[f >> 2] | 0, 0) | 0;
   while (1) {
    if (!(c[k >> 2] | 0)) break;
    c[m >> 2] = c[(c[k >> 2] | 0) + 16 >> 2];
    if (d[(c[k >> 2] | 0) + 12 >> 0] & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 4;
    }
    a : do if (d[(c[k >> 2] | 0) + 12 >> 0] & 8 | 0) {
     c[j >> 2] = c[(c[k >> 2] | 0) + 8 >> 2];
     while (1) {
      h = d[c[j >> 2] >> 0] | 0;
      c[m >> 2] = h;
      if (!h) break a;
      if (a[o >> 0] | 0) {
       Hc(c[m >> 2] | 0, 0);
       c[l >> 2] = Zb(c[n >> 2] | 0, 0) | 0;
       c[m >> 2] = c[(c[l >> 2] | 0) + 16 >> 2];
       if (d[(c[l >> 2] | 0) + 12 >> 0] & 1 | 0) {
        c[16552] = (c[16552] | 0) + 1;
        c[16550] = c[16550] | 8;
       }
       Nc(c[l >> 2] | 0);
      }
      b : do switch (c[18865] | 0) {
      case 19:
       {
        b = c[m >> 2] | 0;
        if (a[61800] | 0) {
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = b >>> 24;
         g = (c[m >> 2] | 0) >>> 16 & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         h = (c[m >> 2] | 0) >>> 8 & 255;
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = h;
         g = c[m >> 2] & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         break b;
        } else {
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = b;
         g = (c[m >> 2] | 0) >>> 8 & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         h = (c[m >> 2] | 0) >>> 16 & 255;
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = h;
         g = (c[m >> 2] | 0) >>> 24 & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         break b;
        }
       }
      case 6:
       {
        b = c[m >> 2] | 0;
        if (a[61800] | 0) {
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = b >>> 8;
         g = c[m >> 2] & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         break b;
        } else {
         g = c[16544] | 0;
         c[16544] = g + 1;
         a[1091574 + g >> 0] = b;
         g = (c[m >> 2] | 0) >>> 8 & 255;
         h = c[16544] | 0;
         c[16544] = h + 1;
         a[1091574 + h >> 0] = g;
         break b;
        }
       }
      default:
       {
        g = c[m >> 2] & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
       }
      } while (0);
      c[j >> 2] = (c[j >> 2] | 0) + 1;
     }
    } else {
     if (a[o >> 0] | 0) {
      Hc(c[m >> 2] | 0, d[(c[k >> 2] | 0) + 12 >> 0] | 0);
      c[l >> 2] = Zb(c[n >> 2] | 0, 0) | 0;
      c[m >> 2] = c[(c[l >> 2] | 0) + 16 >> 2];
      if (d[(c[l >> 2] | 0) + 12 >> 0] & 1 | 0) {
       c[16552] = (c[16552] | 0) + 1;
       c[16550] = c[16550] | 16;
      }
      Nc(c[l >> 2] | 0);
     }
     switch (c[18865] | 0) {
     case 19:
      {
       b = c[m >> 2] | 0;
       if (a[61800] | 0) {
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = b >>> 24;
        g = (c[m >> 2] | 0) >>> 16 & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        h = (c[m >> 2] | 0) >>> 8 & 255;
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = h;
        g = c[m >> 2] & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        break a;
       } else {
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = b;
        g = (c[m >> 2] | 0) >>> 8 & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        h = (c[m >> 2] | 0) >>> 16 & 255;
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = h;
        g = (c[m >> 2] | 0) >>> 24 & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        break a;
       }
      }
     case 6:
      {
       b = c[m >> 2] | 0;
       if (a[61800] | 0) {
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = b >>> 8;
        g = c[m >> 2] & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        break a;
       } else {
        g = c[16544] | 0;
        c[16544] = g + 1;
        a[1091574 + g >> 0] = b;
        g = (c[m >> 2] | 0) >>> 8 & 255;
        h = c[16544] | 0;
        c[16544] = h + 1;
        a[1091574 + h >> 0] = g;
        break a;
       }
      }
     default:
      {
       g = c[m >> 2] & 255;
       h = c[16544] | 0;
       c[16544] = h + 1;
       a[1091574 + h >> 0] = g;
       break a;
      }
     }
    } while (0);
    c[k >> 2] = c[c[k >> 2] >> 2];
   }
   nb();
   Nc(c[k >> 2] | 0);
   i = p;
   return;
  }

  function Xa(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0;
   r = i;
   i = i + 80 | 0;
   m = r + 24 | 0;
   l = r + 16 | 0;
   k = r + 8 | 0;
   j = r;
   o = r + 60 | 0;
   e = r + 64 | 0;
   p = r + 56 | 0;
   f = r + 52 | 0;
   g = r + 48 | 0;
   h = r + 44 | 0;
   q = r + 40 | 0;
   c[o >> 2] = b;
   a[e >> 0] = d & 1;
   c[q >> 2] = 87961;
   c[p >> 2] = c[o >> 2];
   a : while (1) {
    if (!(a[c[p >> 2] >> 0] | 0)) break;
    b : do switch (a[c[p >> 2] >> 0] | 0) {
    case 10:
    case 13:
     break a;
    case 59:
     {
      n = 4;
      break a;
     }
    case 9:
     {
      a[c[p >> 2] >> 0] = 32;
      break;
     }
    case 39:
     {
      c[p >> 2] = (c[p >> 2] | 0) + 1;
      if ((a[c[p >> 2] >> 0] | 0) == 9) a[c[p >> 2] >> 0] = 32;
      if ((a[c[p >> 2] >> 0] | 0) == 10) n = 10; else if (!(a[c[p >> 2] >> 0] | 0)) n = 10;
      if ((n | 0) == 10) {
       n = 0;
       a[c[p >> 2] >> 0] = 32;
       a[(c[p >> 2] | 0) + 1 >> 0] = 0;
      }
      if ((a[c[p >> 2] >> 0] | 0) == 32) a[c[p >> 2] >> 0] = -128;
      break;
     }
    case 34:
     {
      c[p >> 2] = (c[p >> 2] | 0) + 1;
      while (1) {
       if (a[c[p >> 2] >> 0] | 0) b = (a[c[p >> 2] >> 0] | 0) != 34; else b = 0;
       d = a[c[p >> 2] >> 0] | 0;
       if (!b) break;
       if ((d | 0) == 32) a[c[p >> 2] >> 0] = -128;
       c[p >> 2] = (c[p >> 2] | 0) + 1;
      }
      if ((d | 0) != 34) {
       Ya(5, 0, c[o >> 2] | 0) | 0;
       c[p >> 2] = (c[p >> 2] | 0) + -1;
      }
      break;
     }
    case 123:
     {
      if (!(a[e >> 0] & 1)) {
       if (a[1092353] & 1) {
        c[j >> 2] = c[p >> 2];
        ve(58133, j) | 0;
       }
       c[g >> 2] = zd((c[p >> 2] | 0) + 1 | 0, 0, 10) | 0;
       c[h >> 2] = 0;
       while (1) {
        if (!(a[c[p >> 2] >> 0] | 0)) break;
        if ((a[c[p >> 2] >> 0] | 0) == 125) break;
        c[h >> 2] = (c[h >> 2] | 0) + -1;
        c[p >> 2] = (c[p >> 2] | 0) + 1;
       }
       if ((a[c[p >> 2] >> 0] | 0) != 125) {
        xe(58151) | 0;
        c[p >> 2] = (c[p >> 2] | 0) + -1;
        break b;
       }
       c[h >> 2] = (c[h >> 2] | 0) + -1;
       c[p >> 2] = (c[p >> 2] | 0) + 1;
       if (a[1092353] & 1) {
        d = c[p >> 2] | 0;
        c[k >> 2] = c[h >> 2];
        c[k + 4 >> 2] = d;
        ve(58170, k) | 0;
       }
       c[f >> 2] = c[(c[18604] | 0) + 20 >> 2];
       while (1) {
        if (!(c[g >> 2] | 0 ? (c[f >> 2] | 0) != 0 : 0)) break;
        c[g >> 2] = (c[g >> 2] | 0) + -1;
        c[f >> 2] = c[c[f >> 2] >> 2];
       }
       if (!(c[f >> 2] | 0)) {
        n = 49;
        break a;
       }
       d = Zd((c[f >> 2] | 0) + 4 | 0) | 0;
       c[h >> 2] = (c[h >> 2] | 0) + d;
       if (a[1092353] & 1) {
        b = (c[f >> 2] | 0) + 4 | 0;
        d = Zd((c[f >> 2] | 0) + 4 | 0) | 0;
        c[l >> 2] = b;
        c[l + 4 >> 2] = d;
        ve(58188, l) | 0;
       }
       d = (c[p >> 2] | 0) + (c[h >> 2] | 0) | 0;
       d = d + (Zd(c[p >> 2] | 0) | 0) + 1 | 0;
       if (d >>> 0 > ((c[o >> 2] | 0) + 1024 | 0) >>> 0) {
        if (a[1092353] & 1) {
         t = c[p >> 2] | 0;
         s = c[o >> 2] | 0;
         b = c[h >> 2] | 0;
         d = Zd(c[p >> 2] | 0) | 0;
         c[m >> 2] = t;
         c[m + 4 >> 2] = s;
         c[m + 8 >> 2] = b;
         c[m + 12 >> 2] = d;
         ve(58207, m) | 0;
        }
        Na(58252);
       }
       s = (c[p >> 2] | 0) + (c[h >> 2] | 0) | 0;
       t = c[p >> 2] | 0;
       Oe(s | 0, t | 0, (Zd(c[p >> 2] | 0) | 0) + 1 | 0) | 0;
       c[p >> 2] = (c[p >> 2] | 0) + (c[h >> 2] | 0);
       t = c[p >> 2] | 0;
       t = t + (0 - (Zd((c[f >> 2] | 0) + 4 | 0) | 0)) | 0;
       if (t >>> 0 < (c[o >> 2] | 0) >>> 0) Na(58261);
       s = c[p >> 2] | 0;
       s = s + (0 - (Zd((c[f >> 2] | 0) + 4 | 0) | 0)) | 0;
       t = (c[f >> 2] | 0) + 4 | 0;
       Oe(s | 0, t | 0, Zd((c[f >> 2] | 0) + 4 | 0) | 0) | 0;
       t = Zd((c[f >> 2] | 0) + 4 | 0) | 0;
       c[p >> 2] = (c[p >> 2] | 0) + (0 - t);
       if ((c[p >> 2] | 0) >>> 0 < (c[o >> 2] | 0) >>> 0) n = 47; else if ((c[p >> 2] | 0) >>> 0 >= ((c[o >> 2] | 0) + 1024 | 0) >>> 0) n = 47;
       if ((n | 0) == 47) {
        n = 0;
        Na(58270);
       }
       c[p >> 2] = (c[p >> 2] | 0) + -1;
      }
      break;
     }
    default:
     {}
    } while (0);
    c[p >> 2] = (c[p >> 2] | 0) + 1;
   }
   if ((n | 0) == 4) c[q >> 2] = (c[p >> 2] | 0) + 1; else if ((n | 0) == 49) Ya(12, 0, 0) | 0;
   while (1) {
    if ((c[p >> 2] | 0) != (c[o >> 2] | 0)) d = (a[(c[p >> 2] | 0) + -1 >> 0] | 0) == 32; else d = 0;
    b = c[p >> 2] | 0;
    if (!d) break;
    c[p >> 2] = b + -1;
   }
   a[b >> 0] = 0;
   i = r;
   return c[q >> 2] | 0;
  }

  function Ie(a, b, d, e, f) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, i = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0;
   l = a;
   j = b;
   k = j;
   h = d;
   n = e;
   i = n;
   if (!k) {
    g = (f | 0) != 0;
    if (!i) {
     if (g) {
      c[f >> 2] = (l >>> 0) % (h >>> 0);
      c[f + 4 >> 2] = 0;
     }
     n = 0;
     f = (l >>> 0) / (h >>> 0) >>> 0;
     return (D = n, f) | 0;
    } else {
     if (!g) {
      n = 0;
      f = 0;
      return (D = n, f) | 0;
     }
     c[f >> 2] = a | 0;
     c[f + 4 >> 2] = b & 0;
     n = 0;
     f = 0;
     return (D = n, f) | 0;
    }
   }
   g = (i | 0) == 0;
   do if (!h) {
    if (g) {
     if (f | 0) {
      c[f >> 2] = (k >>> 0) % (h >>> 0);
      c[f + 4 >> 2] = 0;
     }
     n = 0;
     f = (k >>> 0) / (h >>> 0) >>> 0;
     return (D = n, f) | 0;
    }
    if (!l) {
     if (f | 0) {
      c[f >> 2] = 0;
      c[f + 4 >> 2] = (k >>> 0) % (i >>> 0);
     }
     n = 0;
     f = (k >>> 0) / (i >>> 0) >>> 0;
     return (D = n, f) | 0;
    }
    g = i - 1 | 0;
    if (!(g & i)) {
     if (f | 0) {
      c[f >> 2] = a | 0;
      c[f + 4 >> 2] = g & k | b & 0;
     }
     n = 0;
     f = k >>> ((He(i | 0) | 0) >>> 0);
     return (D = n, f) | 0;
    }
    g = (V(i | 0) | 0) - (V(k | 0) | 0) | 0;
    if (g >>> 0 <= 30) {
     b = g + 1 | 0;
     i = 31 - g | 0;
     h = b;
     a = k << i | l >>> (b >>> 0);
     b = k >>> (b >>> 0);
     g = 0;
     i = l << i;
     break;
    }
    if (!f) {
     n = 0;
     f = 0;
     return (D = n, f) | 0;
    }
    c[f >> 2] = a | 0;
    c[f + 4 >> 2] = j | b & 0;
    n = 0;
    f = 0;
    return (D = n, f) | 0;
   } else {
    if (!g) {
     g = (V(i | 0) | 0) - (V(k | 0) | 0) | 0;
     if (g >>> 0 <= 31) {
      m = g + 1 | 0;
      i = 31 - g | 0;
      b = g - 31 >> 31;
      h = m;
      a = l >>> (m >>> 0) & b | k << i;
      b = k >>> (m >>> 0) & b;
      g = 0;
      i = l << i;
      break;
     }
     if (!f) {
      n = 0;
      f = 0;
      return (D = n, f) | 0;
     }
     c[f >> 2] = a | 0;
     c[f + 4 >> 2] = j | b & 0;
     n = 0;
     f = 0;
     return (D = n, f) | 0;
    }
    g = h - 1 | 0;
    if (g & h | 0) {
     i = (V(h | 0) | 0) + 33 - (V(k | 0) | 0) | 0;
     p = 64 - i | 0;
     m = 32 - i | 0;
     j = m >> 31;
     o = i - 32 | 0;
     b = o >> 31;
     h = i;
     a = m - 1 >> 31 & k >>> (o >>> 0) | (k << m | l >>> (i >>> 0)) & b;
     b = b & k >>> (i >>> 0);
     g = l << p & j;
     i = (k << p | l >>> (o >>> 0)) & j | l << m & i - 33 >> 31;
     break;
    }
    if (f | 0) {
     c[f >> 2] = g & l;
     c[f + 4 >> 2] = 0;
    }
    if ((h | 0) == 1) {
     o = j | b & 0;
     p = a | 0 | 0;
     return (D = o, p) | 0;
    } else {
     p = He(h | 0) | 0;
     o = k >>> (p >>> 0) | 0;
     p = k << 32 - p | l >>> (p >>> 0) | 0;
     return (D = o, p) | 0;
    }
   } while (0);
   if (!h) {
    k = i;
    j = 0;
    i = 0;
   } else {
    m = d | 0 | 0;
    l = n | e & 0;
    k = De(m | 0, l | 0, -1, -1) | 0;
    d = D;
    j = i;
    i = 0;
    do {
     e = j;
     j = g >>> 31 | j << 1;
     g = i | g << 1;
     e = a << 1 | e >>> 31 | 0;
     n = a >>> 31 | b << 1 | 0;
     Ce(k | 0, d | 0, e | 0, n | 0) | 0;
     p = D;
     o = p >> 31 | ((p | 0) < 0 ? -1 : 0) << 1;
     i = o & 1;
     a = Ce(e | 0, n | 0, o & m | 0, (((p | 0) < 0 ? -1 : 0) >> 31 | ((p | 0) < 0 ? -1 : 0) << 1) & l | 0) | 0;
     b = D;
     h = h - 1 | 0;
    } while ((h | 0) != 0);
    k = j;
    j = 0;
   }
   h = 0;
   if (f | 0) {
    c[f >> 2] = a;
    c[f + 4 >> 2] = b;
   }
   o = (g | 0) >>> 31 | (k | h) << 1 | (h << 1 | g >>> 31) & 0 | j;
   p = (g << 1 | 0 >>> 31) & -2 | i;
   return (D = o, p) | 0;
  }

  function Wc(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0;
   q = i;
   i = i + 48 | 0;
   h = q + 28 | 0;
   j = q + 24 | 0;
   k = q + 20 | 0;
   l = q + 16 | 0;
   m = q + 12 | 0;
   n = q + 8 | 0;
   o = q + 4 | 0;
   p = q + 33 | 0;
   f = q + 32 | 0;
   g = q;
   c[h >> 2] = b;
   c[j >> 2] = e;
   Mc();
   c[l >> 2] = 0;
   c[m >> 2] = 0;
   c[k >> 2] = 0;
   while (1) {
    if (!(a[(c[h >> 2] | 0) + (c[k >> 2] | 0) >> 0] | 0)) break;
    if (44 == (a[(c[h >> 2] | 0) + (c[k >> 2] | 0) >> 0] | 0)) {
     c[l >> 2] = (c[l >> 2] | 0) + 1;
     c[m >> 2] = c[k >> 2];
    }
    c[k >> 2] = (c[k >> 2] | 0) + 1;
   }
   if (1 != (c[l >> 2] | 0)) {
    _c(5, c[(c[j >> 2] | 0) + 8 >> 2] | 0, c[h >> 2] | 0, 0);
    i = q;
    return;
   }
   a[(c[h >> 2] | 0) + (c[m >> 2] | 0) >> 0] = 0;
   c[n >> 2] = c[h >> 2];
   c[o >> 2] = (c[h >> 2] | 0) + ((c[m >> 2] | 0) + 1);
   if (c[m >> 2] | 0) if (wd(a[(c[h >> 2] | 0) + ((c[m >> 2] | 0) - 1) >> 0] | 0) | 0) a[(c[h >> 2] | 0) + ((c[m >> 2] | 0) - 1) >> 0] = 0;
   if (wd(a[c[o >> 2] >> 0] | 0) | 0) c[o >> 2] = (c[o >> 2] | 0) + 1;
   a[p >> 0] = $c(c[n >> 2] | 0) | 0;
   if (29 == (d[p >> 0] | 0)) if (ad(c[n >> 2] | 0, p) | 0) {
    Zc(0);
    i = q;
    return;
   }
   a[f >> 0] = $c(c[o >> 2] | 0) | 0;
   if (29 == (d[f >> 0] | 0)) if (ad(c[o >> 2] | 0, f) | 0) {
    Zc(0);
    i = q;
    return;
   }
   a[(c[h >> 2] | 0) + (c[m >> 2] | 0) >> 0] = 44;
   if (c[m >> 2] | 0) if (!(a[(c[h >> 2] | 0) + ((c[m >> 2] | 0) - 1) >> 0] | 0)) a[(c[h >> 2] | 0) + ((c[m >> 2] | 0) - 1) >> 0] = 32;
   c[g >> 2] = -1;
   a : do switch (d[p >> 0] | 0) {
   case 16:
    switch (d[f >> 0] | 0) {
    case 19:
     {
      c[g >> 2] = 10;
      break a;
     }
    case 22:
     {
      c[g >> 2] = 1;
      break a;
     }
    case 21:
     {
      c[g >> 2] = 0;
      break a;
     }
    case 27:
     {
      c[g >> 2] = 3;
      break a;
     }
    case 26:
     {
      c[g >> 2] = 2;
      break a;
     }
    default:
     {
      if ((d[f >> 0] | 0) >= 15) break a;
      c[g >> 2] = 64 | d[f >> 0];
      break a;
     }
    }
   case 17:
    switch (d[f >> 0] | 0) {
    case 18:
     {
      c[g >> 2] = 16;
      break a;
     }
    case 25:
     {
      c[g >> 2] = 15;
      break a;
     }
    default:
     break a;
    }
   case 18:
    {
     if (17 == (d[f >> 0] | 0)) c[g >> 2] = 17;
     break;
    }
   case 19:
    {
     if (16 == (d[f >> 0] | 0)) c[g >> 2] = 11;
     break;
    }
   case 20:
    {
     if (24 == (d[f >> 0] | 0)) c[g >> 2] = 8;
     break;
    }
   case 22:
    {
     if (16 == (d[f >> 0] | 0)) c[g >> 2] = 5;
     break;
    }
   case 21:
    {
     if (16 == (d[f >> 0] | 0)) c[g >> 2] = 4;
     break;
    }
   case 23:
    {
     if (25 == (d[f >> 0] | 0)) c[g >> 2] = 13;
     break;
    }
   case 24:
    {
     if (20 == (d[f >> 0] | 0)) c[g >> 2] = 9;
     break;
    }
   case 25:
    {
     if (17 == (d[f >> 0] | 0)) c[g >> 2] = 14;
     break;
    }
   case 27:
    {
     if (16 == (d[f >> 0] | 0)) c[g >> 2] = 7;
     break;
    }
   case 26:
    {
     if (16 == (d[f >> 0] | 0)) c[g >> 2] = 6;
     break;
    }
   case 28:
    {
     if (9 == (d[f >> 0] | 0)) c[g >> 2] = 29;
     break;
    }
   default:
    {
     if (15 > (d[p >> 0] | 0)) if (16 == (d[f >> 0] | 0)) {
      c[g >> 2] = 80 | d[p >> 0];
      break a;
     }
     if (9 == (d[p >> 0] | 0)) if (28 == (d[f >> 0] | 0)) c[g >> 2] = 30;
    }
   } while (0);
   if ((c[g >> 2] | 0) < 0) {
    _c(34, c[(c[j >> 2] | 0) + 8 >> 2] | 0, c[h >> 2] | 0, 1);
    i = q;
    return;
   } else {
    Zc(c[g >> 2] & 255);
    i = q;
    return;
   }
  }

  function Vd(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0;
   r = i;
   i = i + 208 | 0;
   o = r + 8 | 0;
   p = r;
   h = S(d, b) | 0;
   n = p;
   c[n >> 2] = 1;
   c[n + 4 >> 2] = 0;
   if (h | 0) {
    n = 0 - d | 0;
    c[o + 4 >> 2] = d;
    c[o >> 2] = d;
    f = 2;
    b = d;
    g = d;
    while (1) {
     b = b + d + g | 0;
     c[o + (f << 2) >> 2] = b;
     if (b >>> 0 < h >>> 0) {
      m = g;
      f = f + 1 | 0;
      g = b;
      b = m;
     } else break;
    }
    j = a + h + n | 0;
    m = p + 4 | 0;
    if (j >>> 0 > a >>> 0) {
     k = j;
     f = 1;
     h = a;
     g = 1;
     while (1) {
      do if ((g & 3 | 0) == 3) {
       Wd(h, d, e, f, o);
       l = c[m >> 2] | 0;
       b = l << 30 | (c[p >> 2] | 0) >>> 2;
       c[p >> 2] = b;
       c[m >> 2] = l >>> 2;
       f = f + 2 | 0;
      } else {
       b = f + -1 | 0;
       if ((c[o + (b << 2) >> 2] | 0) >>> 0 < (k - h | 0) >>> 0) Wd(h, d, e, f, o); else Xd(h, d, e, p, f, 0, o);
       if ((f | 0) == 1) {
        b = c[p >> 2] | 0;
        c[m >> 2] = b >>> 31 | c[m >> 2] << 1;
        b = b << 1;
        c[p >> 2] = b;
        f = 0;
        break;
       }
       if (b >>> 0 > 31) {
        g = c[p >> 2] | 0;
        c[m >> 2] = g;
        c[p >> 2] = 0;
        b = f + -33 | 0;
        f = g;
        g = 0;
       } else {
        f = c[m >> 2] | 0;
        g = c[p >> 2] | 0;
       }
       c[m >> 2] = g >>> (32 - b | 0) | f << b;
       b = g << b;
       c[p >> 2] = b;
       f = 1;
      } while (0);
      g = b | 1;
      c[p >> 2] = g;
      b = h + d | 0;
      if (b >>> 0 >= j >>> 0) break; else h = b;
     }
    } else {
     f = 1;
     b = a;
    }
    Xd(b, d, e, p, f, 0, o);
    l = p + 4 | 0;
    h = c[p >> 2] | 0;
    a = c[l >> 2] | 0;
    g = (a | 0) == 0;
    if (!((f | 0) == 1 & (h | 0) == 1 & g)) {
     k = f;
     while (1) {
      if ((k | 0) < 2) {
       f = h + -1 | 0;
       do if (!f) {
        f = 32;
        q = 28;
       } else {
        if (!(f & 1)) {
         g = f;
         f = 0;
         do {
          f = f + 1 | 0;
          g = g >>> 1;
         } while (!(g & 1 | 0));
        } else {
         if (g) f = 32; else {
          if (!(a & 1)) {
           g = a;
           f = 0;
          } else {
           j = 0;
           g = a;
           f = 0;
           break;
          }
          do {
           f = f + 1 | 0;
           g = g >>> 1;
          } while (!(g & 1 | 0));
         }
         f = f + 32 | 0;
        }
        if (f >>> 0 > 31) q = 28; else {
         j = f;
         g = a;
        }
       } while (0);
       if ((q | 0) == 28) {
        q = 0;
        c[p >> 2] = a;
        c[m >> 2] = 0;
        j = f + -32 | 0;
        h = a;
        g = 0;
       }
       c[p >> 2] = g << 32 - j | h >>> j;
       c[m >> 2] = g >>> j;
       b = b + n | 0;
       f = f + k | 0;
      } else {
       j = h >>> 30;
       f = k + -2 | 0;
       c[p >> 2] = (h << 1 & 2147483646 | j << 31) ^ 3;
       c[m >> 2] = (j | a << 2) >>> 1;
       Xd(b + (0 - (c[o + (f << 2) >> 2] | 0)) + n | 0, d, e, p, k + -1 | 0, 1, o);
       k = c[p >> 2] | 0;
       c[m >> 2] = k >>> 31 | c[m >> 2] << 1;
       c[p >> 2] = k << 1 | 1;
       b = b + n | 0;
       Xd(b, d, e, p, f, 1, o);
      }
      h = c[p >> 2] | 0;
      a = c[l >> 2] | 0;
      g = (a | 0) == 0;
      if ((f | 0) == 1 & (h | 0) == 1 & g) break; else k = f;
     }
    }
   }
   i = r;
   return;
  }

  function Ya(b, e, f) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0;
   B = i;
   i = i + 128 | 0;
   z = B + 96 | 0;
   y = B + 88 | 0;
   x = B + 80 | 0;
   w = B + 72 | 0;
   u = B + 64 | 0;
   t = B + 56 | 0;
   s = B + 48 | 0;
   r = B + 40 | 0;
   q = B + 32 | 0;
   p = B + 24 | 0;
   A = B + 16 | 0;
   v = B + 8 | 0;
   o = B;
   g = B + 120 | 0;
   h = B + 116 | 0;
   j = B + 124 | 0;
   k = B + 112 | 0;
   l = B + 108 | 0;
   m = B + 104 | 0;
   n = B + 100 | 0;
   c[h >> 2] = b;
   a[j >> 0] = e & 1;
   c[k >> 2] = f;
   c[n >> 2] = 0;
   if ((c[h >> 2] | 0) >>> 0 >= 36 | (c[h >> 2] | 0) < 0) {
    c[g >> 2] = Ya(26, 1, 58004) | 0;
    A = c[g >> 2] | 0;
    i = B;
    return A | 0;
   }
   if (a[8 + ((c[h >> 2] | 0) * 12 | 0) + 4 >> 0] & 1) a[76920] = 1;
   c[m >> 2] = c[18604];
   while (1) {
    if (!((d[(c[m >> 2] | 0) + 16 >> 0] | 0) & 1)) break;
    c[m >> 2] = c[c[m >> 2] >> 2];
   }
   c[l >> 2] = c[8 + ((c[h >> 2] | 0) * 12 | 0) + 8 >> 2];
   c[n >> 2] = c[18872] | 0 ? c[18874] | 0 : c[14187] | 0;
   switch (c[16555] | 0) {
   case 0:
    {
     if ((c[n >> 2] | 0) != (c[14187] | 0)) {
      A = c[n >> 2] | 0;
      r = c[(c[m >> 2] | 0) + 12 >> 2] | 0;
      c[o >> 2] = c[(c[m >> 2] | 0) + 4 >> 2];
      c[o + 4 >> 2] = r;
      le(A, 58021, o) | 0;
     }
     A = c[(c[m >> 2] | 0) + 12 >> 2] | 0;
     c[v >> 2] = c[(c[m >> 2] | 0) + 4 >> 2];
     c[v + 4 >> 2] = A;
     Dd(87962, 58021, v) | 0;
     break;
    }
   case 1:
    {
     if ((c[n >> 2] | 0) != (c[14187] | 0)) {
      v = c[n >> 2] | 0;
      r = c[(c[m >> 2] | 0) + 4 >> 2] | 0;
      c[A >> 2] = c[(c[m >> 2] | 0) + 12 >> 2];
      c[A + 4 >> 2] = r;
      le(v, 58039, A) | 0;
     }
     A = c[(c[m >> 2] | 0) + 4 >> 2] | 0;
     c[p >> 2] = c[(c[m >> 2] | 0) + 12 >> 2];
     c[p + 4 >> 2] = A;
     Dd(87962, 58039, p) | 0;
     break;
    }
   case 2:
    {
     if ((c[n >> 2] | 0) != (c[14187] | 0)) {
      A = c[n >> 2] | 0;
      v = c[(c[m >> 2] | 0) + 12 >> 2] | 0;
      c[q >> 2] = c[(c[m >> 2] | 0) + 4 >> 2];
      c[q + 4 >> 2] = v;
      le(A, 58056, q) | 0;
     }
     A = c[(c[m >> 2] | 0) + 12 >> 2] | 0;
     c[r >> 2] = c[(c[m >> 2] | 0) + 4 >> 2];
     c[r + 4 >> 2] = A;
     Dd(87962, 58056, r) | 0;
     break;
    }
   default:
    Na(58072);
   }
   if ((c[n >> 2] | 0) != (c[14187] | 0)) {
    v = c[n >> 2] | 0;
    A = c[l >> 2] | 0;
    c[s >> 2] = c[k >> 2] | 0 ? c[k >> 2] | 0 : 87961;
    le(v, A, s) | 0;
    le(c[n >> 2] | 0, 61727, t) | 0;
   }
   A = c[l >> 2] | 0;
   c[u >> 2] = c[k >> 2] | 0 ? c[k >> 2] | 0 : 87961;
   Dd(88462, A, u) | 0;
   Dd(88962, 61727, w) | 0;
   ye(89462, 87962) | 0;
   ye(89462, 88462) | 0;
   ye(89462, 88962) | 0;
   if (a[j >> 0] & 1) {
    a[76922] = 32;
    c[x >> 2] = 76922;
    ve(58110, x) | 0;
    le(c[n >> 2] | 0, 58114, y) | 0;
    c[z >> 2] = 89462;
    ve(58110, z) | 0;
    qa(1);
   }
   c[g >> 2] = c[h >> 2];
   A = c[g >> 2] | 0;
   i = B;
   return A | 0;
  }

  function Qa(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0;
   l = i;
   i = i + 16 | 0;
   f = l + 12 | 0;
   g = l + 8 | 0;
   h = l + 4 | 0;
   j = l;
   c[f >> 2] = b;
   c[j >> 2] = 0;
   c[g >> 2] = 0;
   c[h >> 2] = 1;
   while (1) {
    b = c[g >> 2] | 0;
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) != 32) break;
    c[g >> 2] = b + 1;
   }
   e = c[g >> 2] | 0;
   a : do if ((a[(c[f >> 2] | 0) + b >> 0] | 0) == 94) {
    c[g >> 2] = e + 1;
    while (1) {
     if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) != 32) break a;
     c[g >> 2] = (c[g >> 2] | 0) + 1;
    }
   } else if ((a[(c[f >> 2] | 0) + e >> 0] | 0) == 35) {
    a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] = 32;
    break;
   } else {
    c[g >> 2] = 0;
    break;
   } while (0);
   c[18609] = 1091840 + (c[h >> 2] | 0);
   while (1) {
    if (!(a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0)) break;
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 32) break;
    b = c[g >> 2] | 0;
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 58) {
     k = 15;
     break;
    }
    if ((d[(c[f >> 2] | 0) + b >> 0] | 0) == 128) a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] = 32;
    b = c[g >> 2] | 0;
    c[g >> 2] = b + 1;
    b = a[(c[f >> 2] | 0) + b >> 0] | 0;
    e = c[h >> 2] | 0;
    c[h >> 2] = e + 1;
    a[1091840 + e >> 0] = b;
   }
   if ((k | 0) == 15) c[g >> 2] = b + 1;
   k = c[h >> 2] | 0;
   c[h >> 2] = k + 1;
   a[1091840 + k >> 0] = 0;
   while (1) {
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) != 32) break;
    c[g >> 2] = (c[g >> 2] | 0) + 1;
   }
   c[18610] = 1091840 + (c[h >> 2] | 0);
   while (1) {
    if (!(a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0)) break;
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 32) break;
    if ((d[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 128) a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] = 32;
    e = c[g >> 2] | 0;
    c[g >> 2] = e + 1;
    e = a[(c[f >> 2] | 0) + e >> 0] | 0;
    k = c[h >> 2] | 0;
    c[h >> 2] = k + 1;
    a[1091840 + k >> 0] = e;
   }
   k = c[h >> 2] | 0;
   c[h >> 2] = k + 1;
   a[1091840 + k >> 0] = 0;
   Oa(c[18610] | 0);
   c[j >> 2] = Ra(c[18610] | 0) | 0;
   while (1) {
    if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) != 32) break;
    c[g >> 2] = (c[g >> 2] | 0) + 1;
   }
   c[18611] = 1091840 + (c[h >> 2] | 0);
   while (1) {
    if (!(a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0)) break;
    b : do if ((a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 32) while (1) {
     if ((a[(c[f >> 2] | 0) + ((c[g >> 2] | 0) + 1) >> 0] | 0) != 32) break b;
     c[g >> 2] = (c[g >> 2] | 0) + 1;
    } while (0);
    if ((d[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0) == 128) a[(c[f >> 2] | 0) + (c[g >> 2] | 0) >> 0] = 32;
    e = c[g >> 2] | 0;
    c[g >> 2] = e + 1;
    e = a[(c[f >> 2] | 0) + e >> 0] | 0;
    k = c[h >> 2] | 0;
    c[h >> 2] = k + 1;
    a[1091840 + k >> 0] = e;
   }
   a[1091840 + (c[h >> 2] | 0) >> 0] = 0;
   i = l;
   return c[j >> 2] | 0;
  }

  function fb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0;
   u = i;
   i = i + 96 | 0;
   r = u + 56 | 0;
   q = u + 48 | 0;
   p = u + 40 | 0;
   t = u + 32 | 0;
   s = u + 24 | 0;
   j = u + 16 | 0;
   h = u + 8 | 0;
   k = u + 80 | 0;
   l = u + 84 | 0;
   m = u + 76 | 0;
   f = u + 72 | 0;
   n = u + 68 | 0;
   g = u + 64 | 0;
   o = u + 60 | 0;
   c[k >> 2] = b;
   a[l >> 0] = e & 1;
   c[g >> 2] = 0;
   le(c[k >> 2] | 0, 58517, u) | 0;
   c[n >> 2] = 0;
   while (1) {
    if ((c[n >> 2] | 0) >= 1024) break;
    c[f >> 2] = c[66224 + (c[n >> 2] << 2) >> 2];
    while (1) {
     if (!(c[f >> 2] | 0)) break;
     c[g >> 2] = (c[g >> 2] | 0) + 1;
     c[f >> 2] = c[c[f >> 2] >> 2];
    }
    c[n >> 2] = (c[n >> 2] | 0) + 1;
   }
   c[m >> 2] = bb(c[g >> 2] << 2) | 0;
   if (!(c[m >> 2] | 0)) {
    le(c[k >> 2] | 0, 58533, h) | 0;
    c[n >> 2] = 0;
    while (1) {
     if ((c[n >> 2] | 0) >= 1024) break;
     c[f >> 2] = c[66224 + (c[n >> 2] << 2) >> 2];
     while (1) {
      if (!(c[f >> 2] | 0)) break;
      t = c[k >> 2] | 0;
      r = c[(c[f >> 2] | 0) + 4 >> 2] | 0;
      s = Ka(c[(c[f >> 2] | 0) + 16 >> 2] | 0, d[(c[f >> 2] | 0) + 12 >> 0] | 0) | 0;
      c[j >> 2] = r;
      c[j + 4 >> 2] = s;
      le(t, 58575, j) | 0;
      c[f >> 2] = c[c[f >> 2] >> 2];
     }
     c[n >> 2] = (c[n >> 2] | 0) + 1;
    }
    t = c[k >> 2] | 0;
    re(58646, t) | 0;
    i = u;
    return;
   }
   c[o >> 2] = 0;
   c[n >> 2] = 0;
   while (1) {
    if ((c[n >> 2] | 0) >= 1024) break;
    c[f >> 2] = c[66224 + (c[n >> 2] << 2) >> 2];
    while (1) {
     if (!(c[f >> 2] | 0)) break;
     h = c[f >> 2] | 0;
     j = c[o >> 2] | 0;
     c[o >> 2] = j + 1;
     c[(c[m >> 2] | 0) + (j << 2) >> 2] = h;
     c[f >> 2] = c[c[f >> 2] >> 2];
    }
    c[n >> 2] = (c[n >> 2] | 0) + 1;
   }
   b = c[k >> 2] | 0;
   if (a[l >> 0] & 1) {
    le(b, 58585, s) | 0;
    Vd(c[m >> 2] | 0, c[o >> 2] | 0, 4, 1);
   } else {
    le(b, 58607, t) | 0;
    Vd(c[m >> 2] | 0, c[o >> 2] | 0, 4, 2);
   }
   c[n >> 2] = 0;
   while (1) {
    if ((c[n >> 2] | 0) >= (c[o >> 2] | 0)) break;
    t = c[k >> 2] | 0;
    l = c[(c[(c[m >> 2] | 0) + (c[n >> 2] << 2) >> 2] | 0) + 4 >> 2] | 0;
    s = Ka(c[(c[(c[m >> 2] | 0) + (c[n >> 2] << 2) >> 2] | 0) + 16 >> 2] | 0, d[(c[(c[m >> 2] | 0) + (c[n >> 2] << 2) >> 2] | 0) + 12 >> 0] | 0) | 0;
    c[p >> 2] = l;
    c[p + 4 >> 2] = s;
    le(t, 58628, p) | 0;
    if ((d[(c[(c[m >> 2] | 0) + (c[n >> 2] << 2) >> 2] | 0) + 12 >> 0] | 0) & 8 | 0) {
     t = c[k >> 2] | 0;
     c[q >> 2] = c[(c[(c[m >> 2] | 0) + (c[n >> 2] << 2) >> 2] | 0) + 8 >> 2];
     le(t, 58640, q) | 0;
    }
    le(c[k >> 2] | 0, 61727, r) | 0;
    c[n >> 2] = (c[n >> 2] | 0) + 1;
   }
   Ae(c[m >> 2] | 0);
   t = c[k >> 2] | 0;
   re(58646, t) | 0;
   i = u;
   return;
  }

  function ib() {
   var a = 0, b = 0, e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0, u = 0, v = 0, w = 0, x = 0, y = 0, z = 0, A = 0, B = 0, C = 0, D = 0, E = 0, F = 0, G = 0, H = 0;
   A = i;
   i = i + 224 | 0;
   y = A + 200 | 0;
   x = A + 192 | 0;
   w = A + 184 | 0;
   v = A + 176 | 0;
   u = A + 168 | 0;
   t = A + 160 | 0;
   s = A + 152 | 0;
   r = A + 144 | 0;
   q = A + 136 | 0;
   p = A + 128 | 0;
   o = A + 120 | 0;
   n = A + 112 | 0;
   m = A + 104 | 0;
   l = A + 96 | 0;
   k = A + 88 | 0;
   j = A + 80 | 0;
   h = A + 72 | 0;
   g = A + 64 | 0;
   f = A + 56 | 0;
   z = A + 32 | 0;
   B = A + 8 | 0;
   a = A + 212 | 0;
   b = A + 208 | 0;
   e = A + 204 | 0;
   c[e >> 2] = 60155;
   ve(60188, A) | 0;
   C = c[e >> 2] | 0;
   c[B >> 2] = 60261;
   c[B + 4 >> 2] = 87961;
   c[B + 8 >> 2] = 60274;
   c[B + 12 >> 2] = 60282;
   c[B + 16 >> 2] = 60291;
   c[B + 20 >> 2] = 60300;
   ve(C, B) | 0;
   c[a >> 2] = c[18606];
   while (1) {
    if (!(c[a >> 2] | 0)) break;
    c[b >> 2] = (d[(c[a >> 2] | 0) + 8 >> 0] | 0) & 16 | 0 ? 60310 : 60314;
    C = c[e >> 2] | 0;
    H = c[(c[a >> 2] | 0) + 4 >> 2] | 0;
    G = c[b >> 2] | 0;
    F = Ka(c[(c[a >> 2] | 0) + 20 >> 2] | 0, d[(c[a >> 2] | 0) + 28 >> 0] | 0) | 0;
    E = Ka(c[(c[a >> 2] | 0) + 24 >> 2] | 0, d[(c[a >> 2] | 0) + 29 >> 0] | 0) | 0;
    D = Ka(c[(c[a >> 2] | 0) + 12 >> 2] | 0, d[(c[a >> 2] | 0) + 8 >> 0] | 0) | 0;
    B = Ka(c[(c[a >> 2] | 0) + 16 >> 2] | 0, d[(c[a >> 2] | 0) + 9 >> 0] | 0) | 0;
    c[z >> 2] = H;
    c[z + 4 >> 2] = G;
    c[z + 8 >> 2] = F;
    c[z + 12 >> 2] = E;
    c[z + 16 >> 2] = D;
    c[z + 20 >> 2] = B;
    ve(C, z) | 0;
    c[a >> 2] = c[c[a >> 2] >> 2];
   }
   xe(60318) | 0;
   c[f >> 2] = c[16551];
   ve(60389, f) | 0;
   c[g >> 2] = c[16552];
   ve(60424, g) | 0;
   if (!(c[16550] | 0)) {
    ve(61727, y) | 0;
    i = A;
    return;
   }
   if (c[16550] & 1 | 0) ve(60469, h) | 0;
   if (c[16550] & 2 | 0) ve(60510, j) | 0;
   if (c[16550] & 4 | 0) ve(60551, k) | 0;
   if (c[16550] & 8 | 0) ve(60588, l) | 0;
   if (c[16550] & 16 | 0) ve(60655, m) | 0;
   if (c[16550] & 32 | 0) ve(60722, n) | 0;
   if (c[16550] & 64 | 0) ve(60759, o) | 0;
   if (c[16550] & 128 | 0) ve(60800, p) | 0;
   if (c[16550] & 256 | 0) ve(60866, q) | 0;
   if (c[16550] & 512 | 0) ve(60926, r) | 0;
   if (c[16550] & 1024 | 0) ve(60960, s) | 0;
   if (c[16550] & 2048 | 0) ve(61018, t) | 0;
   if (c[16550] & 4096 | 0) ve(61051, u) | 0;
   if (c[16550] & 8192 | 0) ve(61088, v) | 0;
   if (c[16550] & 16384 | 0) ve(61156, w) | 0;
   if (!(c[16550] & 32768)) {
    ve(61727, y) | 0;
    i = A;
    return;
   }
   ve(61231, x) | 0;
   ve(61727, y) | 0;
   i = A;
   return;
  }

  function nb() {
   var b = 0, e = 0, f = 0, g = 0, h = 0;
   g = i;
   i = i + 32 | 0;
   f = g;
   b = g + 16 | 0;
   e = g + 12 | 0;
   if (!(c[16552] | 0)) if (!(d[(c[18607] | 0) + 8 >> 0] & 16)) {
    c[e >> 2] = (c[16544] | 0) - 1;
    while (1) {
     if ((c[e >> 2] | 0) < 0) break;
     c[18871] = (c[18871] | 0) + (d[1091574 + (c[e >> 2] | 0) >> 0] | 0);
     c[e >> 2] = (c[e >> 2] | 0) + -1;
    }
    if (a[1092355] | 0) {
     a[1092355] = 0;
     if (d[(c[18607] | 0) + 8 >> 0] & 1 | 0) {
      c[16552] = (c[16552] | 0) + 1;
      c[16550] = c[16550] | 2;
      i = g;
      return;
     }
     c[16546] = c[(c[18607] | 0) + 12 >> 2];
     if ((c[111] | 0) < 3) {
      we(c[16546] & 255, c[18875] | 0) | 0;
      we((c[16546] | 0) >>> 8 & 255, c[18875] | 0) | 0;
      if ((c[111] | 0) == 2) {
       c[16547] = ue(c[18875] | 0) | 0;
       c[16548] = 0;
       we(0, c[18875] | 0) | 0;
       we(0, c[18875] | 0) | 0;
      }
     }
    }
    switch (c[111] | 0) {
    case 1:
    case 3:
     {
      if ((c[(c[18607] | 0) + 12 >> 2] | 0) >>> 0 < (c[16546] | 0) >>> 0) {
       h = c[(c[18607] | 0) + 4 >> 2] | 0;
       b = Ka(c[(c[18607] | 0) + 12 >> 2] | 0, d[(c[18607] | 0) + 8 >> 0] | 0) | 0;
       e = c[16546] | 0;
       c[f >> 2] = h;
       c[f + 4 >> 2] = b;
       c[f + 8 >> 2] = e;
       ve(61449, f) | 0;
       Ya(17, 1, 0) | 0;
       qa(1);
      }
      while (1) {
       if ((c[(c[18607] | 0) + 12 >> 2] | 0) == (c[16546] | 0)) break;
       we(d[61260] | 0, c[18875] | 0) | 0;
       c[16546] = (c[16546] | 0) + 1;
      }
      se(1091574, c[16544] | 0, 1, c[18875] | 0) | 0;
      break;
     }
    case 2:
     {
      if ((c[16546] | 0) != (c[(c[18607] | 0) + 12 >> 2] | 0)) {
       c[16546] = c[(c[18607] | 0) + 12 >> 2];
       c[b >> 2] = ue(c[18875] | 0) | 0;
       ke(c[18875] | 0, c[16547] | 0, 0) | 0;
       we(c[16548] & 255, c[18875] | 0) | 0;
       we(c[16548] >> 8 & 255, c[18875] | 0) | 0;
       ke(c[18875] | 0, c[b >> 2] | 0, 0) | 0;
       we(c[16546] & 255, c[18875] | 0) | 0;
       we((c[16546] | 0) >>> 8 & 255, c[18875] | 0) | 0;
       c[16547] = ue(c[18875] | 0) | 0;
       c[16548] = 0;
       we(0, c[18875] | 0) | 0;
       we(0, c[18875] | 0) | 0;
      }
      se(1091574, c[16544] | 0, 1, c[18875] | 0) | 0;
      c[16548] = (c[16548] | 0) + (c[16544] | 0);
      break;
     }
    default:
     Ya(28, 1, 61413) | 0;
    }
    c[16546] = (c[16546] | 0) + (c[16544] | 0);
   }
   h = (c[18607] | 0) + 12 | 0;
   c[h >> 2] = (c[h >> 2] | 0) + (c[16544] | 0);
   if (!(d[(c[18607] | 0) + 8 >> 0] & 32)) {
    i = g;
    return;
   }
   h = (c[18607] | 0) + 16 | 0;
   c[h >> 2] = (c[h >> 2] | 0) + (c[16544] | 0);
   i = g;
   return;
  }

  function Mc() {
   var b = 0, e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0;
   p = i;
   i = i + 4160 | 0;
   o = p + 16 | 0;
   n = p;
   f = p + 40 | 0;
   g = p + 36 | 0;
   h = p + 32 | 0;
   j = p + 28 | 0;
   e = p + 4145 | 0;
   k = p + 4144 | 0;
   l = p + 24 | 0;
   m = p + 48 | 0;
   c[h >> 2] = c[18607];
   a[e >> 0] = d[(c[h >> 2] | 0) + 8 >> 0] & 32;
   b = c[h >> 2] | 0;
   if (d[e >> 0] | 0) b = a[b + 9 >> 0] | 0; else b = a[b + 8 >> 0] | 0;
   a[k >> 0] = b;
   b = c[h >> 2] | 0;
   if (d[e >> 0] | 0) b = c[b + 16 >> 2] | 0; else b = c[b + 12 >> 2] | 0;
   c[l >> 2] = b;
   c[18876] = c[(c[h >> 2] | 0) + 12 >> 2];
   c[18877] = d[(c[h >> 2] | 0) + 8 >> 0];
   c[j >> 2] = c[18609];
   if (!(a[c[j >> 2] >> 0] | 0)) {
    i = p;
    return;
   }
   c[f >> 2] = Zd(c[j >> 2] | 0) | 0;
   if ((a[(c[j >> 2] | 0) + ((c[f >> 2] | 0) - 1) >> 0] | 0) == 58) c[f >> 2] = (c[f >> 2] | 0) + -1;
   if ((a[c[j >> 2] >> 0] | 0) != 46) if ((a[(c[j >> 2] | 0) + ((c[f >> 2] | 0) - 1) >> 0] | 0) != 36) {
    c[18870] = (c[18870] | 0) + 1;
    c[18869] = c[18870];
   }
   h = Ic(c[j >> 2] | 0, c[f >> 2] | 0) | 0;
   c[g >> 2] = h;
   do if (h | 0) {
    if ((d[(c[g >> 2] | 0) + 12 >> 0] & 5 | 0) == 5) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 8192;
     if (!(a[1092353] & 1)) break;
     m = d[(c[g >> 2] | 0) + 12 >> 0] | 0;
     o = d[k >> 0] | 0;
     c[n >> 2] = c[(c[g >> 2] | 0) + 4 >> 2];
     c[n + 4 >> 2] = m;
     c[n + 8 >> 2] = o;
     ve(62258, n) | 0;
     break;
    }
    if (d[k >> 0] & 1 | 0) if (d[(c[g >> 2] | 0) + 12 >> 0] & 4 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 8192;
     break;
    }
    if (!(d[k >> 0] & 1)) if (!(d[(c[g >> 2] | 0) + 12 >> 0] & 1)) if ((c[l >> 2] | 0) != (c[(c[g >> 2] | 0) + 16 >> 2] | 0)) {
     if (!(c[16553] & 2)) {
      j = c[(c[g >> 2] | 0) + 4 >> 2] | 0;
      n = Ka(c[(c[g >> 2] | 0) + 16 >> 2] | 0, 0) | 0;
      c[o >> 2] = j;
      c[o + 4 >> 2] = n;
      Dd(m, 62283, o) | 0;
      Ya(22, 0, m) | 0;
     }
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 16384;
    }
   } else c[g >> 2] = Kc(c[j >> 2] | 0, c[f >> 2] | 0) | 0; while (0);
   c[(c[g >> 2] | 0) + 16 >> 2] = c[l >> 2];
   a[(c[g >> 2] | 0) + 12 >> 0] = d[(c[g >> 2] | 0) + 12 >> 0] & -2 | d[k >> 0] & 1;
   i = p;
   return;
  }

  function Xd(a, b, d, e, f, g, h) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   g = g | 0;
   h = h | 0;
   var j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0;
   q = i;
   i = i + 240 | 0;
   o = q;
   j = c[e >> 2] | 0;
   k = c[e + 4 >> 2] | 0;
   c[o >> 2] = a;
   n = 0 - b | 0;
   a : do if ((k | 0) != 0 | (j | 0) != 1) {
    l = a + (0 - (c[h + (f << 2) >> 2] | 0)) | 0;
    if ((Aa[d & 3](l, a) | 0) < 1) {
     e = a;
     a = 1;
     p = 18;
    } else {
     m = 1;
     g = (g | 0) == 0;
     e = a;
     while (1) {
      if (g & (f | 0) > 1) {
       g = e + n | 0;
       a = c[h + (f + -2 << 2) >> 2] | 0;
       if ((Aa[d & 3](g, l) | 0) > -1) {
        g = m;
        p = 19;
        break a;
       }
       if ((Aa[d & 3](g + (0 - a) | 0, l) | 0) > -1) {
        g = m;
        p = 19;
        break a;
       }
      }
      g = m + 1 | 0;
      c[o + (m << 2) >> 2] = l;
      e = j + -1 | 0;
      do if (!e) {
       e = 0;
       a = 32;
       p = 15;
      } else {
       if (!(e & 1)) {
        a = 0;
        do {
         a = a + 1 | 0;
         e = e >>> 1;
        } while (!(e & 1 | 0));
       } else {
        if (!k) e = 32; else {
         if (!(k & 1)) {
          a = k;
          e = 0;
         } else {
          e = 0;
          a = 0;
          break;
         }
         do {
          e = e + 1 | 0;
          a = a >>> 1;
         } while (!(a & 1 | 0));
        }
        a = e + 32 | 0;
       }
       if (a >>> 0 > 31) {
        e = a + -32 | 0;
        p = 15;
       } else e = a;
      } while (0);
      if ((p | 0) == 15) {
       p = 0;
       j = k;
       k = 0;
      }
      j = k << 32 - e | j >>> e;
      k = k >>> e;
      f = a + f | 0;
      if (!((k | 0) != 0 | (j | 0) != 1)) {
       e = l;
       p = 19;
       break a;
      }
      e = l + (0 - (c[h + (f << 2) >> 2] | 0)) | 0;
      if ((Aa[d & 3](e, c[o >> 2] | 0) | 0) < 1) {
       e = l;
       a = g;
       g = 0;
       p = 18;
       break;
      } else {
       a = l;
       m = g;
       g = 1;
       l = e;
       e = a;
      }
     }
    }
   } else {
    e = a;
    a = 1;
    p = 18;
   } while (0);
   if ((p | 0) == 18) if (!g) {
    g = a;
    p = 19;
   }
   if ((p | 0) == 19) {
    Yd(b, o, g);
    Wd(e, b, d, f, h);
   }
   i = q;
   return;
  }

  function Va(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0;
   q = i;
   i = i + 80 | 0;
   o = q + 48 | 0;
   p = q + 24 | 0;
   g = q + 16 | 0;
   f = q;
   h = q + 68 | 0;
   j = q + 73 | 0;
   e = q + 72 | 0;
   k = q + 64 | 0;
   l = q + 60 | 0;
   m = q + 56 | 0;
   n = q + 52 | 0;
   c[h >> 2] = b;
   if (d[(c[18604] | 0) + 16 >> 0] & 2 | 0) {
    i = q;
    return;
   }
   if (d[(c[18608] | 0) + 9 >> 0] | 0) b = (d[(c[18608] | 0) + 10 >> 0] | 0) != 0; else b = 0;
   a[j >> 0] = b ? 32 : 45;
   a[e >> 0] = c[18877] & 16 | 0 ? 85 : 32;
   c[k >> 2] = c[16540];
   c[l >> 2] = 87961;
   if (c[k >> 2] | 0) c[l >> 2] = 64261; else c[k >> 2] = 87961;
   r = c[(c[18604] | 0) + 12 >> 2] | 0;
   b = a[e >> 0] | 0;
   e = Ka(c[18876] | 0, c[18877] & 7) | 0;
   c[f >> 2] = r;
   c[f + 4 >> 2] = b;
   c[f + 8 >> 2] = e;
   Dd(1089462, 58312, f) | 0;
   c[n >> 2] = Zd(1089462) | 0;
   c[m >> 2] = 0;
   while (1) {
    if (!((c[m >> 2] | 0) < (c[16544] | 0) ? (c[m >> 2] | 0) < 4 : 0)) break;
    r = 1089462 + (c[n >> 2] | 0) | 0;
    c[g >> 2] = d[1091574 + (c[m >> 2] | 0) >> 0];
    Dd(r, 58322, g) | 0;
    c[m >> 2] = (c[m >> 2] | 0) + 1;
    c[n >> 2] = (c[n >> 2] | 0) + 3;
   }
   if ((c[m >> 2] | 0) == 4 ? (c[m >> 2] | 0) < (c[16544] | 0) : 0) a[j >> 0] = 42;
   while (1) {
    b = c[n >> 2] | 0;
    if ((c[m >> 2] | 0) >= 4) break;
    a[1089462 + (b + 2) >> 0] = 32;
    a[1089462 + ((c[n >> 2] | 0) + 1) >> 0] = 32;
    a[1089462 + (c[n >> 2] | 0) >> 0] = 32;
    c[n >> 2] = (c[n >> 2] | 0) + 3;
    c[m >> 2] = (c[m >> 2] | 0) + 1;
   }
   f = c[18609] | 0;
   g = c[18610] | 0;
   l = c[l >> 2] | 0;
   m = c[k >> 2] | 0;
   r = c[18611] | 0;
   c[p >> 2] = a[j >> 0];
   c[p + 4 >> 2] = f;
   c[p + 8 >> 2] = g;
   c[p + 12 >> 2] = l;
   c[p + 16 >> 2] = m;
   c[p + 20 >> 2] = r;
   Dd(1089462 + b + -1 | 0, 58328, p) | 0;
   if (a[c[h >> 2] >> 0] | 0) {
    c[n >> 2] = (Zd(1089462) | 0) - 1;
    r = 1089462 + (c[n >> 2] | 0) | 0;
    c[o >> 2] = c[h >> 2];
    Dd(r, 58347, o) | 0;
   }
   r = Za(1089462, 1090518) | 0;
   se(1090518, r, 1, c[18874] | 0) | 0;
   c[16544] = 0;
   c[16540] = 0;
   i = q;
   return;
  }

  function Hb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   m = i;
   i = i + 32 | 0;
   k = m;
   f = m + 24 | 0;
   l = m + 20 | 0;
   g = m + 16 | 0;
   h = m + 12 | 0;
   j = m + 8 | 0;
   c[f >> 2] = b;
   c[l >> 2] = e;
   c[g >> 2] = Zb(c[f >> 2] | 0, 0) | 0;
   do if ((Zd(c[18609] | 0) | 0) == 1) {
    if ((a[c[18609] >> 0] | 0) != 46) {
     if ((a[c[18609] >> 0] | 0) != 42) break;
     a[c[18609] >> 0] = 46;
    }
    e = c[f >> 2] | 0;
    b = c[l >> 2] | 0;
    if (d[(c[18607] | 0) + 8 >> 0] & 32 | 0) {
     Db(e, b);
     i = m;
     return;
    } else {
     Cb(e, b);
     i = m;
     return;
    }
   } while (0);
   l = c[18609] | 0;
   c[h >> 2] = Ic(l, Zd(c[18609] | 0) | 0) | 0;
   if (!(c[h >> 2] | 0)) {
    l = c[18609] | 0;
    c[h >> 2] = Kc(l, Zd(c[18609] | 0) | 0) | 0;
   }
   do if (!(d[(c[h >> 2] | 0) + 12 >> 0] & 1)) {
    if (d[(c[g >> 2] | 0) + 12 >> 0] & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 512;
     break;
    }
    if ((c[(c[h >> 2] | 0) + 16 >> 2] | 0) != (c[(c[g >> 2] | 0) + 16 >> 2] | 0)) {
     Ya(18, 0, 0) | 0;
     l = c[(c[g >> 2] | 0) + 16 >> 2] | 0;
     c[k >> 2] = c[(c[h >> 2] | 0) + 16 >> 2];
     c[k + 4 >> 2] = l;
     ve(61680, k) | 0;
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 1024;
    }
   } while (0);
   c[(c[h >> 2] | 0) + 16 >> 2] = c[(c[g >> 2] | 0) + 16 >> 2];
   a[(c[h >> 2] | 0) + 12 >> 0] = d[(c[g >> 2] | 0) + 12 >> 0] & 9;
   c[(c[h >> 2] | 0) + 8 >> 2] = c[(c[g >> 2] | 0) + 8 >> 2];
   l = (c[g >> 2] | 0) + 12 | 0;
   a[l >> 0] = d[l >> 0] & -41;
   c[j >> 2] = c[(c[h >> 2] | 0) + 16 >> 2];
   c[16544] = 0;
   if ((c[j >> 2] | 0) >>> 0 > 65535) {
    l = (c[j >> 2] | 0) >>> 24 & 255;
    k = c[16544] | 0;
    c[16544] = k + 1;
    a[1091574 + k >> 0] = l;
    k = (c[j >> 2] | 0) >>> 16 & 255;
    l = c[16544] | 0;
    c[16544] = l + 1;
    a[1091574 + l >> 0] = k;
   }
   l = (c[j >> 2] | 0) >>> 8 & 255;
   k = c[16544] | 0;
   c[16544] = k + 1;
   a[1091574 + k >> 0] = l;
   k = c[j >> 2] & 255;
   l = c[16544] | 0;
   c[16544] = l + 1;
   a[1091574 + l >> 0] = k;
   Nc(c[g >> 2] | 0);
   i = m;
   return;
  }

  function ac(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   m = i;
   i = i + 48 | 0;
   g = m + 16 | 0;
   f = m;
   h = m + 36 | 0;
   e = m + 32 | 0;
   j = m + 28 | 0;
   k = m + 24 | 0;
   l = m + 40 | 0;
   c[e >> 2] = b;
   a[l >> 0] = 0;
   c[k >> 2] = c[e >> 2];
   a : while (1) {
    do if ((a[c[k >> 2] >> 0] | 0) != 95) if ((a[c[k >> 2] >> 0] | 0) != 46) {
     if ((a[c[k >> 2] >> 0] | 0) >= 97) if ((a[c[k >> 2] >> 0] | 0) <= 122) break;
     if ((a[c[k >> 2] >> 0] | 0) >= 65) if ((a[c[k >> 2] >> 0] | 0) <= 90) break;
     if ((a[c[k >> 2] >> 0] | 0) < 48) break a;
     if ((a[c[k >> 2] >> 0] | 0) > 57) break a;
    } while (0);
    c[k >> 2] = (c[k >> 2] | 0) + 1;
   }
   if ((c[k >> 2] | 0) == (c[e >> 2] | 0)) {
    Ya(14, 0, c[e >> 2] | 0) | 0;
    k = a[c[e >> 2] >> 0] | 0;
    l = a[(c[e >> 2] | 0) + -1 >> 0] | 0;
    c[f >> 2] = a[c[e >> 2] >> 0];
    c[f + 4 >> 2] = k;
    c[f + 8 >> 2] = l;
    ve(62137, f) | 0;
    if (c[18872] | 0) {
     l = c[18874] | 0;
     k = a[c[e >> 2] >> 0] | 0;
     c[g >> 2] = a[c[e >> 2] >> 0];
     c[g + 4 >> 2] = k;
     le(l, 62162, g) | 0;
    }
    c[h >> 2] = (c[e >> 2] | 0) + 1;
    l = c[h >> 2] | 0;
    i = m;
    return l | 0;
   }
   if ((a[c[k >> 2] >> 0] | 0) == 36) c[k >> 2] = (c[k >> 2] | 0) + 1;
   g = Ic(c[e >> 2] | 0, (c[k >> 2] | 0) - (c[e >> 2] | 0) | 0) | 0;
   c[j >> 2] = g;
   if (g | 0) {
    if (d[(c[j >> 2] | 0) + 12 >> 0] & 1 | 0) c[16551] = (c[16551] | 0) + 1;
    if (d[(c[j >> 2] | 0) + 12 >> 0] & 32 | 0) {
     a[l >> 0] = 1;
     c[j >> 2] = Zb(c[(c[j >> 2] | 0) + 8 >> 2] | 0, 0) | 0;
    }
    b = c[j >> 2] | 0;
    if (d[(c[j >> 2] | 0) + 12 >> 0] & 8 | 0) Gc(0, 8, c[b + 8 >> 2] | 0); else Gc(c[b + 16 >> 2] | 0, d[(c[j >> 2] | 0) + 12 >> 0] & 1, 0);
    g = (c[j >> 2] | 0) + 12 | 0;
    a[g >> 0] = d[g >> 0] | 68;
    if (a[l >> 0] | 0) Nc(c[j >> 2] | 0);
   } else {
    Gc(0, 1, 0);
    c[j >> 2] = Kc(c[e >> 2] | 0, (c[k >> 2] | 0) - (c[e >> 2] | 0) | 0) | 0;
    a[(c[j >> 2] | 0) + 12 >> 0] = 69;
    c[16551] = (c[16551] | 0) + 1;
   }
   c[h >> 2] = c[k >> 2];
   l = c[h >> 2] | 0;
   i = m;
   return l | 0;
  }

  function Bb(b, e, f) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0;
   p = i;
   i = i + 32 | 0;
   j = p + 16 | 0;
   q = p + 12 | 0;
   k = p + 8 | 0;
   l = p + 4 | 0;
   m = p;
   n = p + 23 | 0;
   o = p + 22 | 0;
   g = p + 21 | 0;
   h = p + 20 | 0;
   c[j >> 2] = b;
   c[q >> 2] = e;
   c[k >> 2] = f;
   c[l >> 2] = c[q >> 2];
   if (!(c[l >> 2] | 0)) {
    i = p;
    return;
   }
   a[n >> 0] = c[j >> 2] >> 24;
   a[o >> 0] = c[j >> 2] >> 16;
   a[g >> 0] = c[j >> 2] >> 8;
   a[h >> 0] = c[j >> 2];
   a : do switch (c[k >> 2] | 0) {
   case 1:
    {
     Ee(1091574, d[h >> 0] & 255 | 0, 256) | 0;
     break;
    }
   case 2:
    {
     c[l >> 2] = c[l >> 2] << 1;
     c[m >> 2] = 0;
     while (1) {
      if ((c[m >> 2] | 0) >>> 0 >= 256) break a;
      if (a[61800] | 0) {
       a[1091574 + ((c[m >> 2] | 0) + 0) >> 0] = a[g >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 1) >> 0] = a[h >> 0] | 0;
      } else {
       a[1091574 + ((c[m >> 2] | 0) + 0) >> 0] = a[h >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 1) >> 0] = a[g >> 0] | 0;
      }
      c[m >> 2] = (c[m >> 2] | 0) + 2;
     }
    }
   case 4:
    {
     c[l >> 2] = c[l >> 2] << 2;
     c[m >> 2] = 0;
     while (1) {
      if ((c[m >> 2] | 0) >>> 0 >= 256) break a;
      if (a[61800] | 0) {
       a[1091574 + ((c[m >> 2] | 0) + 0) >> 0] = a[n >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 1) >> 0] = a[o >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 2) >> 0] = a[g >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 3) >> 0] = a[h >> 0] | 0;
      } else {
       a[1091574 + ((c[m >> 2] | 0) + 0) >> 0] = a[h >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 1) >> 0] = a[g >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 2) >> 0] = a[o >> 0] | 0;
       a[1091574 + ((c[m >> 2] | 0) + 3) >> 0] = a[n >> 0] | 0;
      }
      c[m >> 2] = (c[m >> 2] | 0) + 4;
     }
    }
   default:
    {}
   } while (0);
   c[16544] = 256;
   while (1) {
    if ((c[l >> 2] | 0) >>> 0 <= 256) break;
    nb();
    c[l >> 2] = (c[l >> 2] | 0) - 256;
   }
   c[16544] = c[l >> 2];
   nb();
   i = p;
   return;
  }

  function Ta(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0, t = 0;
   t = i;
   i = i + 1088 | 0;
   r = t;
   k = t + 48 | 0;
   l = t + 40 | 0;
   m = t + 36 | 0;
   n = t + 32 | 0;
   o = t + 28 | 0;
   p = t + 24 | 0;
   q = t + 20 | 0;
   f = t + 16 | 0;
   g = t + 56 | 0;
   h = t + 12 | 0;
   j = t + 8 | 0;
   c[k >> 2] = b;
   c[t + 44 >> 2] = e;
   c[m >> 2] = 0;
   if (d[(c[18608] | 0) + 9 >> 0] | 0) b = (d[(c[18608] | 0) + 10 >> 0] | 0) != 0; else b = 0;
   c[h >> 2] = (b ^ 1) & 1;
   Ua(c[k >> 2] | 0) | 0;
   if (c[h >> 2] | 0) c[m >> 2] = 1; else {
    c[m >> 2] = (Ra(c[k >> 2] | 0) | 0) != 0 & 1;
    if (c[18872] | 0) if (a[61801] | 0) Va(87961);
   }
   if (!(c[m >> 2] | 0)) {
    c[l >> 2] = 0;
    c[n >> 2] = l;
    c[p >> 2] = Wa(20) | 0;
    c[f >> 2] = Sa(c[k >> 2] | 0) | 0;
    c[c[p >> 2] >> 2] = c[70320 + (c[f >> 2] << 2) >> 2];
    c[(c[p >> 2] | 0) + 4 >> 2] = 43;
    e = Wa((Zd(c[k >> 2] | 0) | 0) + 1 | 0) | 0;
    k = $d(e, c[k >> 2] | 0) | 0;
    c[(c[p >> 2] | 0) + 8 >> 2] = k;
    a[(c[p >> 2] | 0) + 12 >> 0] = 8;
    c[70320 + (c[f >> 2] << 2) >> 2] = c[p >> 2];
   }
   while (1) {
    if (!(je(g, 1024, c[(c[18604] | 0) + 8 >> 2] | 0) | 0)) {
     s = 22;
     break;
    }
    if (a[1092353] & 1) {
     c[r >> 2] = c[18604];
     c[r + 4 >> 2] = g;
     ve(57994, r) | 0;
    }
    k = (c[18604] | 0) + 12 | 0;
    c[k >> 2] = (c[k >> 2] | 0) + 1;
    c[j >> 2] = Xa(g, 1) | 0;
    c[q >> 2] = Qa(g) | 0;
    if ((a[c[18610] >> 0] | 0) != 0 & (c[q >> 2] | 0) != 0) if (d[(c[q >> 2] | 0) + 12 >> 0] & 128 | 0) break;
    if ((c[h >> 2] | 0) == 0 & (c[18872] | 0) != 0) if (a[61801] | 0) Va(c[j >> 2] | 0);
    if (c[m >> 2] | 0) continue;
    c[o >> 2] = Wa(5 + (Zd(g) | 0) | 0) | 0;
    $d((c[o >> 2] | 0) + 4 | 0, g) | 0;
    c[c[n >> 2] >> 2] = c[o >> 2];
    c[n >> 2] = c[o >> 2];
   }
   if ((s | 0) == 22) {
    Ya(13, 1, 0) | 0;
    i = t;
    return;
   }
   if (c[m >> 2] | 0) {
    i = t;
    return;
   }
   c[(c[p >> 2] | 0) + 16 >> 2] = c[l >> 2];
   i = t;
   return;
  }

  function Kd(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0.0;
   a : do if (b >>> 0 <= 20) do switch (b | 0) {
   case 9:
    {
     e = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     b = c[e >> 2] | 0;
     c[d >> 2] = e + 4;
     c[a >> 2] = b;
     break a;
    }
   case 10:
    {
     e = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     b = c[e >> 2] | 0;
     c[d >> 2] = e + 4;
     e = a;
     c[e >> 2] = b;
     c[e + 4 >> 2] = ((b | 0) < 0) << 31 >> 31;
     break a;
    }
   case 11:
    {
     e = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     b = c[e >> 2] | 0;
     c[d >> 2] = e + 4;
     e = a;
     c[e >> 2] = b;
     c[e + 4 >> 2] = 0;
     break a;
    }
   case 12:
    {
     e = (c[d >> 2] | 0) + (8 - 1) & ~(8 - 1);
     b = e;
     f = c[b >> 2] | 0;
     b = c[b + 4 >> 2] | 0;
     c[d >> 2] = e + 8;
     e = a;
     c[e >> 2] = f;
     c[e + 4 >> 2] = b;
     break a;
    }
   case 13:
    {
     f = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     e = c[f >> 2] | 0;
     c[d >> 2] = f + 4;
     e = (e & 65535) << 16 >> 16;
     f = a;
     c[f >> 2] = e;
     c[f + 4 >> 2] = ((e | 0) < 0) << 31 >> 31;
     break a;
    }
   case 14:
    {
     f = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     e = c[f >> 2] | 0;
     c[d >> 2] = f + 4;
     f = a;
     c[f >> 2] = e & 65535;
     c[f + 4 >> 2] = 0;
     break a;
    }
   case 15:
    {
     f = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     e = c[f >> 2] | 0;
     c[d >> 2] = f + 4;
     e = (e & 255) << 24 >> 24;
     f = a;
     c[f >> 2] = e;
     c[f + 4 >> 2] = ((e | 0) < 0) << 31 >> 31;
     break a;
    }
   case 16:
    {
     f = (c[d >> 2] | 0) + (4 - 1) & ~(4 - 1);
     e = c[f >> 2] | 0;
     c[d >> 2] = f + 4;
     f = a;
     c[f >> 2] = e & 255;
     c[f + 4 >> 2] = 0;
     break a;
    }
   case 17:
    {
     f = (c[d >> 2] | 0) + (8 - 1) & ~(8 - 1);
     g = +h[f >> 3];
     c[d >> 2] = f + 8;
     h[a >> 3] = g;
     break a;
    }
   case 18:
    {
     f = (c[d >> 2] | 0) + (8 - 1) & ~(8 - 1);
     g = +h[f >> 3];
     c[d >> 2] = f + 8;
     h[a >> 3] = g;
     break a;
    }
   default:
    break a;
   } while (0); while (0);
   return;
  }

  function Ic(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0;
   o = i;
   i = i + 1088 | 0;
   m = o + 16 | 0;
   l = o;
   n = o + 44 | 0;
   f = o + 40 | 0;
   g = o + 36 | 0;
   h = o + 32 | 0;
   j = o + 28 | 0;
   k = o + 48 | 0;
   c[f >> 2] = b;
   c[g >> 2] = e;
   c[g >> 2] = (c[g >> 2] | 0) > 1024 ? 1024 : e;
   b = c[g >> 2] | 0;
   if ((a[c[f >> 2] >> 0] | 0) == 46) {
    if ((b | 0) == 1) {
     b = c[18607] | 0;
     if (d[(c[18607] | 0) + 8 >> 0] & 32 | 0) {
      a[76340] = d[b + 9 >> 0] & 1;
      c[19086] = c[(c[18607] | 0) + 16 >> 2];
     } else {
      a[76340] = d[b + 8 >> 0] & 1;
      c[19086] = c[(c[18607] | 0) + 12 >> 2];
     }
     c[n >> 2] = 76328;
     n = c[n >> 2] | 0;
     i = o;
     return n | 0;
    }
    if ((c[g >> 2] | 0) == 2) if ((a[(c[f >> 2] | 0) + 1 >> 0] | 0) == 46) {
     c[n >> 2] = 76304;
     n = c[n >> 2] | 0;
     i = o;
     return n | 0;
    }
    if ((c[g >> 2] | 0) == 3) if ((a[(c[f >> 2] | 0) + 1 >> 0] | 0) == 46) if ((a[(c[f >> 2] | 0) + 2 >> 0] | 0) == 46) {
     a[76364] = 0;
     c[19092] = c[18871];
     c[n >> 2] = 76352;
     n = c[n >> 2] | 0;
     i = o;
     return n | 0;
    }
    e = c[g >> 2] | 0;
    m = c[f >> 2] | 0;
    c[l >> 2] = c[18867];
    c[l + 4 >> 2] = e;
    c[l + 8 >> 2] = m;
    Dd(k, 62241, l) | 0;
    c[g >> 2] = Zd(k) | 0;
    c[f >> 2] = k;
   } else if ((a[(c[f >> 2] | 0) + (b - 1) >> 0] | 0) == 36) {
    e = c[g >> 2] | 0;
    l = c[f >> 2] | 0;
    c[m >> 2] = c[18869];
    c[m + 4 >> 2] = e;
    c[m + 8 >> 2] = l;
    Dd(k, 62249, m) | 0;
    c[g >> 2] = Zd(k) | 0;
    c[f >> 2] = k;
   }
   c[h >> 2] = Jc(c[f >> 2] | 0, c[g >> 2] | 0) | 0;
   c[j >> 2] = c[66224 + (c[h >> 2] << 2) >> 2];
   while (1) {
    if (!(c[j >> 2] | 0)) break;
    if ((c[(c[j >> 2] | 0) + 20 >> 2] | 0) == (c[g >> 2] | 0)) if (!(Bd(c[(c[j >> 2] | 0) + 4 >> 2] | 0, c[f >> 2] | 0, c[g >> 2] | 0) | 0)) break;
    c[j >> 2] = c[c[j >> 2] >> 2];
   }
   c[n >> 2] = c[j >> 2];
   n = c[n >> 2] | 0;
   i = o;
   return n | 0;
  }

  function Lb(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   m = i;
   i = i + 32 | 0;
   e = m + 24 | 0;
   f = m + 20 | 0;
   g = m + 16 | 0;
   h = m + 12 | 0;
   j = m + 8 | 0;
   k = m + 4 | 0;
   l = m;
   c[e >> 2] = b;
   c[f >> 2] = d;
   Mc();
   if ((c[18866] | 0) == 32) {
    xe(61729) | 0;
    i = m;
    return;
   }
   c[18866] = (c[18866] | 0) + 1;
   c[h >> 2] = bb(4 + (Zd(c[e >> 2] | 0) | 0) + 1 | 0) | 0;
   c[c[h >> 2] >> 2] = 0;
   $d((c[h >> 2] | 0) + 4 | 0, c[e >> 2] | 0) | 0;
   c[j >> 2] = c[h >> 2];
   a : while (1) {
    if (!(a[c[e >> 2] >> 0] | 0)) break;
    if ((a[c[e >> 2] >> 0] | 0) == 10) break;
    c[l >> 2] = c[e >> 2];
    while (1) {
     if (a[c[e >> 2] >> 0] | 0) if ((a[c[e >> 2] >> 0] | 0) != 10) b = (a[c[e >> 2] >> 0] | 0) != 44; else b = 0; else b = 0;
     d = c[e >> 2] | 0;
     if (!b) break;
     c[e >> 2] = d + 1;
    }
    c[k >> 2] = bb(5 + (d - (c[l >> 2] | 0)) | 0) | 0;
    c[c[k >> 2] >> 2] = 0;
    c[c[j >> 2] >> 2] = c[k >> 2];
    c[j >> 2] = c[k >> 2];
    Ne((c[k >> 2] | 0) + 4 | 0, c[l >> 2] | 0, (c[e >> 2] | 0) - (c[l >> 2] | 0) | 0) | 0;
    a[(c[k >> 2] | 0) + 4 + ((c[e >> 2] | 0) - (c[l >> 2] | 0)) >> 0] = 0;
    if ((a[c[e >> 2] >> 0] | 0) == 44) c[e >> 2] = (c[e >> 2] | 0) + 1;
    while (1) {
     if ((a[c[e >> 2] >> 0] | 0) != 32) continue a;
     c[e >> 2] = (c[e >> 2] | 0) + 1;
    }
   }
   c[g >> 2] = ab(36) | 0;
   c[c[g >> 2] >> 2] = c[18604];
   c[(c[g >> 2] | 0) + 4 >> 2] = c[(c[f >> 2] | 0) + 8 >> 2];
   c[(c[g >> 2] | 0) + 8 >> 2] = c[(c[18604] | 0) + 8 >> 2];
   c[(c[g >> 2] | 0) + 12 >> 2] = 0;
   a[(c[g >> 2] | 0) + 16 >> 0] = 1;
   c[(c[g >> 2] | 0) + 28 >> 2] = c[18867];
   c[(c[g >> 2] | 0) + 32 >> 2] = c[18869];
   c[(c[g >> 2] | 0) + 24 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
   c[(c[g >> 2] | 0) + 20 >> 2] = c[h >> 2];
   c[18604] = c[g >> 2];
   c[18868] = (c[18868] | 0) + 1;
   c[18867] = c[18868];
   c[18870] = (c[18870] | 0) + 1;
   c[18869] = c[18870];
   i = m;
   return;
  }

  function Fb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   l = i;
   i = i + 32 | 0;
   m = l + 16 | 0;
   f = l + 8 | 0;
   g = l + 21 | 0;
   h = l + 20 | 0;
   j = l + 4 | 0;
   k = l;
   c[m >> 2] = b;
   c[l + 12 >> 2] = e;
   c[f >> 2] = Zb(c[m >> 2] | 0, 0) | 0;
   a[g >> 0] = 0;
   a[h >> 0] = d[(c[18607] | 0) + 8 >> 0] & 32;
   b = c[18607] | 0;
   if (a[h >> 0] | 0) {
    m = b + 9 | 0;
    a[m >> 0] = d[m >> 0] | 4;
   } else {
    m = b + 8 | 0;
    a[m >> 0] = d[m >> 0] | 4;
   }
   do if (c[c[f >> 2] >> 2] | 0) if (d[(c[c[f >> 2] >> 2] | 0) + 12 >> 0] & 1 | 0) {
    c[16552] = (c[16552] | 0) + 1;
    c[16550] = c[16550] | 64;
    break;
   } else {
    a[g >> 0] = c[(c[c[f >> 2] >> 2] | 0) + 16 >> 2];
    break;
   } while (0);
   b = c[18607] | 0;
   if (a[h >> 0] | 0) {
    if ((d[b + 9 >> 0] | d[(c[f >> 2] | 0) + 12 >> 0]) & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 128;
     m = c[f >> 2] | 0;
     Nc(m);
     Mc();
     i = l;
     return;
    }
    c[j >> 2] = (c[(c[f >> 2] | 0) + 16 >> 2] | 0) - (((c[(c[18607] | 0) + 16 >> 2] | 0) >>> 0) % ((c[(c[f >> 2] | 0) + 16 >> 2] | 0) >>> 0) | 0);
    if ((c[j >> 2] | 0) == (c[(c[f >> 2] | 0) + 16 >> 2] | 0)) {
     m = c[f >> 2] | 0;
     Nc(m);
     Mc();
     i = l;
     return;
    }
    Bb(d[g >> 0] | 0, c[j >> 2] | 0, 1);
    m = c[f >> 2] | 0;
    Nc(m);
    Mc();
    i = l;
    return;
   } else {
    if ((d[b + 8 >> 0] | d[(c[f >> 2] | 0) + 12 >> 0]) & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 256;
     m = c[f >> 2] | 0;
     Nc(m);
     Mc();
     i = l;
     return;
    }
    c[k >> 2] = (c[(c[f >> 2] | 0) + 16 >> 2] | 0) - (((c[(c[18607] | 0) + 12 >> 2] | 0) >>> 0) % ((c[(c[f >> 2] | 0) + 16 >> 2] | 0) >>> 0) | 0);
    if ((c[k >> 2] | 0) == (c[(c[f >> 2] | 0) + 16 >> 2] | 0)) {
     m = c[f >> 2] | 0;
     Nc(m);
     Mc();
     i = l;
     return;
    }
    Bb(d[g >> 0] | 0, c[k >> 2] | 0, 1);
    m = c[f >> 2] | 0;
    Nc(m);
    Mc();
    i = l;
    return;
   }
  }

  function Oa(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   e = f;
   c[e >> 2] = b;
   c[18865] = -1;
   c[16540] = 0;
   a : do if ((a[c[e >> 2] >> 0] | 0) != 46) {
    while (1) {
     if (a[c[e >> 2] >> 0] | 0) d = (a[c[e >> 2] >> 0] | 0) != 46; else d = 0;
     b = c[e >> 2] | 0;
     if (!d) break;
     c[e >> 2] = b + 1;
    }
    if (a[b >> 0] | 0) {
     a[c[e >> 2] >> 0] = 0;
     c[e >> 2] = (c[e >> 2] | 0) + 1;
     c[16540] = c[e >> 2];
     switch (a[c[e >> 2] >> 0] | 32 | 0) {
     case 105:
     case 48:
      {
       c[18865] = 0;
       switch (a[(c[e >> 2] | 0) + 1 >> 0] | 32 | 0) {
       case 120:
        {
         c[18865] = 13;
         break a;
        }
       case 121:
        {
         c[18865] = 14;
         break a;
        }
       case 110:
        {
         c[18865] = 12;
         break a;
        }
       default:
        break a;
       }
      }
     case 122:
     case 98:
     case 100:
      switch (a[(c[e >> 2] | 0) + 1 >> 0] | 32 | 0) {
      case 120:
       {
        c[18865] = 4;
        break a;
       }
      case 121:
       {
        c[18865] = 5;
        break a;
       }
      case 105:
       {
        c[18865] = 15;
        break a;
       }
      case 98:
       {
        c[18865] = 16;
        break a;
       }
      default:
       {
        c[18865] = 3;
        break a;
       }
      }
     case 97:
     case 119:
     case 101:
      switch (a[(c[e >> 2] | 0) + 1 >> 0] | 32 | 0) {
      case 120:
       {
        c[18865] = 7;
        break a;
       }
      case 121:
       {
        c[18865] = 8;
        break a;
       }
      default:
       {
        c[18865] = 6;
        break a;
       }
      }
     case 108:
      {
       c[18865] = 19;
       break a;
      }
     case 114:
      {
       c[18865] = 9;
       break a;
      }
     case 117:
      {
       c[18865] = 20;
       break a;
      }
     default:
      break a;
     }
    }
   } while (0);
   i = f;
   return;
  }

  function Za(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0;
   k = i;
   i = i + 32 | 0;
   l = k + 20 | 0;
   h = k + 16 | 0;
   j = k + 12 | 0;
   e = k + 8 | 0;
   f = k + 4 | 0;
   g = k;
   c[l >> 2] = b;
   c[h >> 2] = d;
   c[j >> 2] = c[h >> 2];
   c[e >> 2] = c[l >> 2];
   c[f >> 2] = 0;
   while (1) {
    if (!(a[c[e >> 2] >> 0] | 0)) break;
    if ((a[c[e >> 2] >> 0] | 0) == 10) break;
    a[c[j >> 2] >> 0] = a[c[e >> 2] >> 0] | 0;
    if ((a[c[e >> 2] >> 0] | 0) == 9) {
     while (1) {
      if ((c[f >> 2] | 0) <= 0) break;
      if ((a[(c[j >> 2] | 0) + -1 >> 0] | 0) != 32) break;
      c[j >> 2] = (c[j >> 2] | 0) + -1;
      c[f >> 2] = (c[f >> 2] | 0) + -1;
     }
     c[f >> 2] = 0;
     a[c[j >> 2] >> 0] = 9;
    }
    if ((c[f >> 2] | 0) == 7) if ((a[c[j >> 2] >> 0] | 0) == 32) if ((a[(c[j >> 2] | 0) + -1 >> 0] | 0) == 32) {
     c[g >> 2] = c[f >> 2];
     while (1) {
      l = c[g >> 2] | 0;
      c[g >> 2] = l + -1;
      if ((l | 0) >= 0) d = (a[c[j >> 2] >> 0] | 0) == 32; else d = 0;
      b = c[j >> 2] | 0;
      if (!d) break;
      c[j >> 2] = b + -1;
     }
     l = b + 1 | 0;
     c[j >> 2] = l;
     a[l >> 0] = 9;
    }
    c[e >> 2] = (c[e >> 2] | 0) + 1;
    c[j >> 2] = (c[j >> 2] | 0) + 1;
    c[f >> 2] = (c[f >> 2] | 0) + 1 & 7;
   }
   while (1) {
    if ((c[j >> 2] | 0) != (c[h >> 2] | 0)) if ((a[(c[j >> 2] | 0) + -1 >> 0] | 0) == 32) d = 1; else d = (a[(c[j >> 2] | 0) + -1 >> 0] | 0) == 9; else d = 0;
    b = c[j >> 2] | 0;
    if (!d) break;
    c[j >> 2] = b + -1;
   }
   c[j >> 2] = b + 1;
   a[b >> 0] = 10;
   a[c[j >> 2] >> 0] = 0;
   i = k;
   return (c[j >> 2] | 0) - (c[h >> 2] | 0) | 0;
  }

  function hd(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0;
   q = i;
   i = i + 48 | 0;
   n = q + 16 | 0;
   m = q;
   j = q + 32 | 0;
   o = a + 28 | 0;
   h = c[o >> 2] | 0;
   c[j >> 2] = h;
   p = a + 20 | 0;
   h = (c[p >> 2] | 0) - h | 0;
   c[j + 4 >> 2] = h;
   c[j + 8 >> 2] = b;
   c[j + 12 >> 2] = d;
   k = a + 60 | 0;
   l = a + 44 | 0;
   g = 2;
   b = h + d | 0;
   while (1) {
    if (!(c[19094] | 0)) {
     c[n >> 2] = c[k >> 2];
     c[n + 4 >> 2] = j;
     c[n + 8 >> 2] = g;
     f = jd(ua(146, n | 0) | 0) | 0;
    } else {
     ra(1, a | 0);
     c[m >> 2] = c[k >> 2];
     c[m + 4 >> 2] = j;
     c[m + 8 >> 2] = g;
     f = jd(ua(146, m | 0) | 0) | 0;
     fa(0);
    }
    if ((b | 0) == (f | 0)) {
     b = 6;
     break;
    }
    if ((f | 0) < 0) {
     b = 8;
     break;
    }
    b = b - f | 0;
    e = c[j + 4 >> 2] | 0;
    if (f >>> 0 > e >>> 0) {
     h = c[l >> 2] | 0;
     c[o >> 2] = h;
     c[p >> 2] = h;
     f = f - e | 0;
     g = g + -1 | 0;
     h = j + 8 | 0;
     e = c[j + 12 >> 2] | 0;
    } else if ((g | 0) == 2) {
     c[o >> 2] = (c[o >> 2] | 0) + f;
     g = 2;
     h = j;
    } else h = j;
    c[h >> 2] = (c[h >> 2] | 0) + f;
    c[h + 4 >> 2] = e - f;
    j = h;
   }
   if ((b | 0) == 6) {
    n = c[l >> 2] | 0;
    c[a + 16 >> 2] = n + (c[a + 48 >> 2] | 0);
    a = n;
    c[o >> 2] = a;
    c[p >> 2] = a;
   } else if ((b | 0) == 8) {
    c[a + 16 >> 2] = 0;
    c[o >> 2] = 0;
    c[p >> 2] = 0;
    c[a >> 2] = c[a >> 2] | 32;
    if ((g | 0) == 2) d = 0; else d = d - (c[j + 4 >> 2] | 0) | 0;
   }
   i = q;
   return d | 0;
  }

  function fe(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0;
   o = i;
   i = i + 112 | 0;
   n = o + 40 | 0;
   l = o + 24 | 0;
   k = o + 16 | 0;
   g = o;
   m = o + 52 | 0;
   f = a[d >> 0] | 0;
   if (!(Nd(66155, f << 24 >> 24, 4) | 0)) {
    c[(kd() | 0) >> 2] = 22;
    e = 0;
   } else {
    e = ze(1144) | 0;
    if (!e) e = 0; else {
     h = e;
     j = h + 112 | 0;
     do {
      c[h >> 2] = 0;
      h = h + 4 | 0;
     } while ((h | 0) < (j | 0));
     if (!(be(d, 43) | 0)) c[e >> 2] = f << 24 >> 24 == 114 ? 8 : 4;
     if (be(d, 101) | 0) {
      c[g >> 2] = b;
      c[g + 4 >> 2] = 2;
      c[g + 8 >> 2] = 1;
      ga(221, g | 0) | 0;
      f = a[d >> 0] | 0;
     }
     if (f << 24 >> 24 == 97) {
      c[k >> 2] = b;
      c[k + 4 >> 2] = 3;
      f = ga(221, k | 0) | 0;
      if (!(f & 1024)) {
       c[l >> 2] = b;
       c[l + 4 >> 2] = 4;
       c[l + 8 >> 2] = f | 1024;
       ga(221, l | 0) | 0;
      }
      d = c[e >> 2] | 128;
      c[e >> 2] = d;
     } else d = c[e >> 2] | 0;
     c[e + 60 >> 2] = b;
     c[e + 44 >> 2] = e + 120;
     c[e + 48 >> 2] = 1024;
     f = e + 75 | 0;
     a[f >> 0] = -1;
     if (!(d & 8)) {
      c[n >> 2] = b;
      c[n + 4 >> 2] = 21505;
      c[n + 8 >> 2] = m;
      if (!(oa(54, n | 0) | 0)) a[f >> 0] = 10;
     }
     c[e + 32 >> 2] = 5;
     c[e + 36 >> 2] = 4;
     c[e + 40 >> 2] = 2;
     c[e + 12 >> 2] = 1;
     if (!(c[19095] | 0)) c[e + 76 >> 2] = -1;
     ha(76404);
     f = c[19100] | 0;
     c[e + 56 >> 2] = f;
     if (f | 0) c[f + 52 >> 2] = e;
     c[19100] = e;
     pa(76404);
    }
   }
   i = o;
   return e | 0;
  }

  function Gc(b, e, f) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0;
   p = i;
   i = i + 48 | 0;
   o = p;
   g = p + 32 | 0;
   h = p + 28 | 0;
   j = p + 24 | 0;
   k = p + 20 | 0;
   l = p + 16 | 0;
   m = p + 12 | 0;
   n = p + 8 | 0;
   c[g >> 2] = b;
   c[h >> 2] = e;
   c[j >> 2] = f;
   c[k >> 2] = 0;
   if (a[1092353] & 1) {
    f = c[18880] | 0;
    c[o >> 2] = c[g >> 2];
    c[o + 4 >> 2] = f;
    ve(62069, o) | 0;
   }
   c[18882] = 0;
   if (c[h >> 2] & 8 | 0) {
    c[l >> 2] = c[j >> 2];
    c[n >> 2] = 0;
    c[g >> 2] = 0;
    while (1) {
     if (!(d[c[l >> 2] >> 0] | 0)) break;
     if ((d[c[l >> 2] >> 0] | 0 | 0) == 34) break;
     c[g >> 2] = c[g >> 2] << 8 | (d[c[l >> 2] >> 0] | 0);
     c[l >> 2] = (c[l >> 2] | 0) + 1;
     c[n >> 2] = (c[n >> 2] | 0) + 1;
    }
    c[m >> 2] = bb((c[n >> 2] | 0) + 1 | 0) | 0;
    Ne(c[m >> 2] | 0, c[j >> 2] | 0, c[n >> 2] | 0) | 0;
    a[(c[m >> 2] | 0) + (c[n >> 2] | 0) >> 0] = 0;
    c[h >> 2] = c[h >> 2] & -9;
    c[k >> 2] = c[m >> 2];
   }
   c[75660 + (c[18880] << 2) >> 2] = c[g >> 2];
   c[75916 + (c[18880] << 2) >> 2] = c[k >> 2];
   a[1092356 + (c[18880] | 0) >> 0] = c[h >> 2];
   o = (c[18880] | 0) + 1 | 0;
   c[18880] = o;
   if ((o | 0) == 64) {
    xe(62089) | 0;
    c[18880] = c[18878];
   }
   while (1) {
    if ((c[18881] | 0) == (c[18879] | 0)) {
     b = 14;
     break;
    }
    if ((c[75532 + ((c[18881] | 0) - 1 << 2) >> 2] | 0) != 128) {
     b = 14;
     break;
    }
    zc();
   }
   if ((b | 0) == 14) {
    i = p;
    return;
   }
  }

  function je(b, e, f) {
   b = b | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, i = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0;
   if ((c[f + 76 >> 2] | 0) > -1) m = Id(f) | 0; else m = 0;
   g = e + -1 | 0;
   if ((e | 0) < 2) {
    n = f + 74 | 0;
    l = a[n >> 0] | 0;
    a[n >> 0] = l + 255 | l;
    if (m | 0) md(f);
    if (!g) a[b >> 0] = 0; else b = 0;
   } else {
    a : do if (!g) {
     e = b;
     n = 17;
    } else {
     k = f + 4 | 0;
     l = f + 8 | 0;
     e = b;
     while (1) {
      h = c[k >> 2] | 0;
      o = h;
      p = (c[l >> 2] | 0) - o | 0;
      i = Nd(h, 10, p) | 0;
      j = (i | 0) == 0;
      i = j ? p : 1 - o + i | 0;
      i = i >>> 0 < g >>> 0 ? i : g;
      Ne(e | 0, h | 0, i | 0) | 0;
      h = (c[k >> 2] | 0) + i | 0;
      c[k >> 2] = h;
      e = e + i | 0;
      i = g - i | 0;
      if (!(j & (i | 0) != 0)) {
       n = 17;
       break a;
      }
      if (h >>> 0 < (c[l >> 2] | 0) >>> 0) {
       c[k >> 2] = h + 1;
       j = d[h >> 0] | 0;
      } else {
       g = xd(f) | 0;
       if ((g | 0) < 0) break; else j = g;
      }
      g = i + -1 | 0;
      h = e + 1 | 0;
      a[e >> 0] = j;
      if (!((g | 0) != 0 & (j & 255 | 0) != 10)) {
       e = h;
       n = 17;
       break a;
      } else e = h;
     }
     if ((e | 0) == (b | 0)) b = 0; else if (!(c[f >> 2] & 16)) b = 0; else n = 17;
    } while (0);
    if ((n | 0) == 17) if (!b) b = 0; else a[e >> 0] = 0;
    if (m) md(f);
   }
   return b | 0;
  }

  function lb(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 16 | 0;
   e = h + 8 | 0;
   f = h;
   c[e >> 2] = b;
   c[h + 4 >> 2] = d;
   c[f >> 2] = c[16549];
   c[16549] = 0;
   if (!(Ad(c[e >> 2] | 0, 61261) | 0)) {
    if (!(a[1091830] & 1)) _a(18268);
    a[61800] = 0;
    c[16549] = 6502;
   }
   if (!(Ad(c[e >> 2] | 0, 61266) | 0)) {
    if (!(a[1091830] & 1)) _a(4540);
    a[61800] = 1;
    c[16549] = 6803;
   }
   if (!(Ad(c[e >> 2] | 0, 61271) | 0)) g = 11; else if (!(Ad(c[e >> 2] | 0, 61278) | 0)) g = 11;
   if ((g | 0) == 11) {
    if (!(a[1091830] & 1)) {
     _a(4540);
     _a(17540);
    }
    a[61800] = 1;
    c[16549] = 6303;
   }
   if (!(Ad(c[e >> 2] | 0, 61285) | 0)) {
    if (!(a[1091830] & 1)) _a(26172);
    a[61800] = 1;
    c[16549] = 68705;
   }
   if (!(Ad(c[e >> 2] | 0, 61291) | 0)) g = 20; else if (!(Ad(c[e >> 2] | 0, 61298) | 0)) g = 20;
   if ((g | 0) == 20) {
    if (!(a[1091830] & 1)) _a(35428);
    a[61800] = 1;
    c[16549] = 6811;
   }
   if (!(Ad(c[e >> 2] | 0, 61305) | 0)) g = 25; else if (!(Ad(c[e >> 2] | 0, 61308) | 0)) g = 25;
   if ((g | 0) == 25) {
    if (!(a[1091830] & 1)) _a(50612);
    a[61800] = 1;
    c[16549] = 248;
   }
   a[1091830] = 1;
   if (!(c[16549] | 0)) Ya(24, 1, c[e >> 2] | 0) | 0;
   if (!(c[f >> 2] | 0)) {
    i = h;
    return;
   }
   if ((c[16549] | 0) == (c[f >> 2] | 0)) {
    i = h;
    return;
   }
   Ya(27, 1, c[e >> 2] | 0) | 0;
   i = h;
   return;
  }

  function Rc(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0;
   n = i;
   i = i + 32 | 0;
   j = n + 28 | 0;
   k = n + 24 | 0;
   e = n + 20 | 0;
   f = n + 16 | 0;
   g = n + 12 | 0;
   h = n + 8 | 0;
   l = n + 4 | 0;
   m = n;
   c[j >> 2] = b;
   c[k >> 2] = d;
   c[e >> 2] = 0;
   c[f >> 2] = 0;
   c[g >> 2] = 0;
   while (1) {
    if (!(a[(c[j >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0)) break;
    if (44 == (a[(c[j >> 2] | 0) + (c[g >> 2] | 0) >> 0] | 0)) {
     c[e >> 2] = (c[e >> 2] | 0) + 1;
     c[f >> 2] = c[g >> 2];
    }
    c[g >> 2] = (c[g >> 2] | 0) + 1;
   }
   if (1 != (c[e >> 2] | 0)) {
    _c(5, c[(c[k >> 2] | 0) + 8 >> 2] | 0, c[j >> 2] | 0, 0);
    i = n;
    return;
   }
   a[(c[j >> 2] | 0) + (c[f >> 2] | 0) >> 0] = 0;
   c[h >> 2] = c[j >> 2];
   c[l >> 2] = (c[j >> 2] | 0) + ((c[f >> 2] | 0) + 1);
   if (Yc(c[h >> 2] | 0, m) | 0) {
    cd(0, 0);
    i = n;
    return;
   }
   a[(c[j >> 2] | 0) + (c[f >> 2] | 0) >> 0] = 44;
   b = c[m >> 2] | 0;
   if (102 == (a[(c[(c[k >> 2] | 0) + 8 >> 2] | 0) + 1 >> 0] | 0)) {
    if (b >>> 0 > 15) {
     _c(30, c[(c[k >> 2] | 0) + 8 >> 2] | 0, c[j >> 2] | 0, 0);
     c[m >> 2] = c[m >> 2] & 15;
    }
   } else if (b >>> 0 > 7) {
    _c(31, c[(c[k >> 2] | 0) + 8 >> 2] | 0, c[j >> 2] | 0, 0);
    c[m >> 2] = c[m >> 2] & 7;
   }
   dd((c[(c[k >> 2] | 0) + 20 >> 2] | c[m >> 2]) & 255, c[l >> 2] | 0);
   i = n;
   return;
  }

  function $c(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0;
   e = i;
   i = i + 16 | 0;
   b = e + 4 | 0;
   d = e;
   c[d >> 2] = a;
   do if (_d(63415, c[d >> 2] | 0) | 0) {
    if (_d(63417, c[d >> 2] | 0) | 0) if (_d(63421, c[d >> 2] | 0) | 0) {
     if (!(_d(63424, c[d >> 2] | 0) | 0)) {
      c[b >> 2] = 18;
      break;
     }
     if (!(_d(63426, c[d >> 2] | 0) | 0)) {
      c[b >> 2] = 19;
      break;
     }
     if (!(_d(63429, c[d >> 2] | 0) | 0)) {
      c[b >> 2] = 20;
      break;
     }
     if (!(_d(63431, c[d >> 2] | 0) | 0)) {
      c[b >> 2] = 21;
      break;
     }
     if (!(_d(63434, c[d >> 2] | 0) | 0)) {
      c[b >> 2] = 22;
      break;
     }
     if (_d(63437, c[d >> 2] | 0) | 0) if (_d(63441, c[d >> 2] | 0) | 0) {
      if (_d(63444, c[d >> 2] | 0) | 0) if (_d(63448, c[d >> 2] | 0) | 0) {
       if (!(_d(63450, c[d >> 2] | 0) | 0)) {
        c[b >> 2] = 25;
        break;
       }
       if (!(_d(63452, c[d >> 2] | 0) | 0)) {
        c[b >> 2] = 26;
        break;
       }
       if (!(_d(63455, c[d >> 2] | 0) | 0)) {
        c[b >> 2] = 27;
        break;
       }
       if (_d(63458, c[d >> 2] | 0) | 0) {
        c[b >> 2] = 29;
        break;
       } else {
        c[b >> 2] = 28;
        break;
       }
      }
      c[b >> 2] = 24;
      break;
     }
     c[b >> 2] = 23;
     break;
    }
    c[b >> 2] = 17;
   } else c[b >> 2] = 16; while (0);
   i = e;
   return c[b >> 2] | 0;
  }

  function Vb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 16 | 0;
   f = j + 12 | 0;
   g = j + 4 | 0;
   h = j;
   c[f >> 2] = b;
   c[j + 8 >> 2] = e;
   if (a[(c[18608] | 0) + 9 >> 0] | 0) if (a[(c[18608] | 0) + 10 >> 0] | 0) {
    Mc();
    c[h >> 2] = Zb(c[f >> 2] | 0, 0) | 0;
    if (!(c[(c[h >> 2] | 0) + 16 >> 2] | 0)) {
     Qb(0);
     Nc(c[h >> 2] | 0);
     i = j;
     return;
    }
    if ((c[(c[h >> 2] | 0) + 16 >> 2] | 0) < 0) {
     Qb(0);
     Nc(c[h >> 2] | 0);
     Ya(25, 0, 0) | 0;
     i = j;
     return;
    }
    c[g >> 2] = ab(24) | 0;
    c[c[g >> 2] >> 2] = c[18605];
    c[(c[g >> 2] | 0) + 16 >> 2] = c[18604];
    b = c[18604] | 0;
    if (d[(c[18604] | 0) + 16 >> 0] & 1 | 0) c[(c[g >> 2] | 0) + 8 >> 2] = c[b + 24 >> 2]; else {
     f = ue(c[b + 8 >> 2] | 0) | 0;
     c[(c[g >> 2] | 0) + 8 >> 2] = f;
    }
    c[(c[g >> 2] | 0) + 12 >> 2] = c[(c[18604] | 0) + 12 >> 2];
    c[(c[g >> 2] | 0) + 4 >> 2] = c[(c[h >> 2] | 0) + 16 >> 2];
    f = a[(c[h >> 2] | 0) + 12 >> 0] | 0;
    a[(c[g >> 2] | 0) + 20 >> 0] = f;
    if (f & 255 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 4096;
    }
    c[18605] = c[g >> 2];
    Nc(c[h >> 2] | 0);
    Qb(1);
    i = j;
    return;
   }
   Qb(0);
   i = j;
   return;
  }

  function Kc(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   m = i;
   i = i + 1088 | 0;
   l = m + 16 | 0;
   k = m;
   e = m + 40 | 0;
   f = m + 36 | 0;
   g = m + 32 | 0;
   h = m + 28 | 0;
   j = m + 44 | 0;
   c[e >> 2] = b;
   c[f >> 2] = d;
   c[f >> 2] = (c[f >> 2] | 0) > 1024 ? 1024 : d;
   if ((a[c[e >> 2] >> 0] | 0) == 46) {
    d = c[f >> 2] | 0;
    l = c[e >> 2] | 0;
    c[k >> 2] = c[18867];
    c[k + 4 >> 2] = d;
    c[k + 8 >> 2] = l;
    Dd(j, 62241, k) | 0;
    c[f >> 2] = Zd(j) | 0;
    c[e >> 2] = j;
   } else if ((a[(c[e >> 2] | 0) + ((c[f >> 2] | 0) - 1) >> 0] | 0) == 36) {
    d = c[f >> 2] | 0;
    k = c[e >> 2] | 0;
    c[l >> 2] = c[18869];
    c[l + 4 >> 2] = d;
    c[l + 8 >> 2] = k;
    Dd(j, 62249, l) | 0;
    c[f >> 2] = Zd(j) | 0;
    c[e >> 2] = j;
   }
   c[g >> 2] = Lc() | 0;
   l = Wa((c[f >> 2] | 0) + 1 | 0) | 0;
   c[(c[g >> 2] | 0) + 4 >> 2] = l;
   Ne(c[(c[g >> 2] | 0) + 4 >> 2] | 0, c[e >> 2] | 0, c[f >> 2] | 0) | 0;
   c[(c[g >> 2] | 0) + 20 >> 2] = c[f >> 2];
   c[h >> 2] = Jc(c[e >> 2] | 0, c[f >> 2] | 0) | 0;
   c[c[g >> 2] >> 2] = c[66224 + (c[h >> 2] << 2) >> 2];
   a[(c[g >> 2] | 0) + 12 >> 0] = 1;
   c[66224 + (c[h >> 2] << 2) >> 2] = c[g >> 2];
   i = m;
   return c[g >> 2] | 0;
  }

  function ad(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   e = k + 12 | 0;
   f = k + 8 | 0;
   g = k + 4 | 0;
   h = k;
   c[f >> 2] = b;
   c[g >> 2] = d;
   do if (_d(63384, c[f >> 2] | 0) | 0) if (_d(63386, c[f >> 2] | 0) | 0) {
    if (_d(63391, c[f >> 2] | 0) | 0) if (_d(63393, c[f >> 2] | 0) | 0) {
     if (_d(63399, c[f >> 2] | 0) | 0) if (_d(63401, c[f >> 2] | 0) | 0) {
      if (!(_d(63407, c[f >> 2] | 0) | 0)) {
       a[c[g >> 2] >> 0] = 9;
       c[e >> 2] = 0;
       break;
      }
      if (!(_d(63409, c[f >> 2] | 0) | 0)) {
       a[c[g >> 2] >> 0] = 10;
       c[e >> 2] = 0;
       break;
      }
      if (!(_d(63412, c[f >> 2] | 0) | 0)) {
       a[c[g >> 2] >> 0] = 11;
       c[e >> 2] = 0;
       break;
      }
      if (Yc(c[f >> 2] | 0, h) | 0) {
       c[e >> 2] = 1;
       break;
      }
      if ((c[h >> 2] | 0) >>> 0 > 14) Ya(32, 1, c[f >> 2] | 0) | 0;
      a[c[g >> 2] >> 0] = c[h >> 2];
      c[e >> 2] = 0;
      break;
     }
     a[c[g >> 2] >> 0] = 14;
     c[e >> 2] = 0;
     break;
    }
    a[c[g >> 2] >> 0] = 13;
    c[e >> 2] = 0;
   } else j = 3; else j = 3; while (0);
   if ((j | 0) == 3) {
    a[c[g >> 2] >> 0] = 12;
    c[e >> 2] = 0;
   }
   i = k;
   return c[e >> 2] | 0;
  }

  function Gd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0, o = 0, p = 0, q = 0, r = 0, s = 0;
   s = i;
   i = i + 224 | 0;
   n = s + 120 | 0;
   p = s + 80 | 0;
   q = s;
   r = s + 136 | 0;
   f = p;
   g = f + 40 | 0;
   do {
    c[f >> 2] = 0;
    f = f + 4 | 0;
   } while ((f | 0) < (g | 0));
   c[n >> 2] = c[e >> 2];
   if ((Hd(0, d, n, q, p) | 0) < 0) e = -1; else {
    if ((c[b + 76 >> 2] | 0) > -1) o = Id(b) | 0; else o = 0;
    e = c[b >> 2] | 0;
    m = e & 32;
    if ((a[b + 74 >> 0] | 0) < 1) c[b >> 2] = e & -33;
    f = b + 48 | 0;
    if (!(c[f >> 2] | 0)) {
     g = b + 44 | 0;
     h = c[g >> 2] | 0;
     c[g >> 2] = r;
     j = b + 28 | 0;
     c[j >> 2] = r;
     k = b + 20 | 0;
     c[k >> 2] = r;
     c[f >> 2] = 80;
     l = b + 16 | 0;
     c[l >> 2] = r + 80;
     e = Hd(b, d, n, q, p) | 0;
     if (h) {
      wa[c[b + 36 >> 2] & 7](b, 0, 0) | 0;
      e = (c[k >> 2] | 0) == 0 ? -1 : e;
      c[g >> 2] = h;
      c[f >> 2] = 0;
      c[l >> 2] = 0;
      c[j >> 2] = 0;
      c[k >> 2] = 0;
     }
    } else e = Hd(b, d, n, q, p) | 0;
    f = c[b >> 2] | 0;
    c[b >> 2] = f | m;
    if (o | 0) md(b);
    e = (f & 32 | 0) == 0 ? e : -1;
   }
   i = s;
   return e | 0;
  }

  function Nd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, i = 0;
   h = d & 255;
   f = (e | 0) != 0;
   a : do if (f & (b & 3 | 0) != 0) {
    g = d & 255;
    while (1) {
     if ((a[b >> 0] | 0) == g << 24 >> 24) {
      i = 6;
      break a;
     }
     b = b + 1 | 0;
     e = e + -1 | 0;
     f = (e | 0) != 0;
     if (!(f & (b & 3 | 0) != 0)) {
      i = 5;
      break;
     }
    }
   } else i = 5; while (0);
   if ((i | 0) == 5) if (f) i = 6; else e = 0;
   b : do if ((i | 0) == 6) {
    g = d & 255;
    if ((a[b >> 0] | 0) != g << 24 >> 24) {
     f = S(h, 16843009) | 0;
     c : do if (e >>> 0 > 3) while (1) {
      h = c[b >> 2] ^ f;
      if ((h & -2139062144 ^ -2139062144) & h + -16843009 | 0) break;
      b = b + 4 | 0;
      e = e + -4 | 0;
      if (e >>> 0 <= 3) {
       i = 11;
       break c;
      }
     } else i = 11; while (0);
     if ((i | 0) == 11) if (!e) {
      e = 0;
      break;
     }
     while (1) {
      if ((a[b >> 0] | 0) == g << 24 >> 24) break b;
      b = b + 1 | 0;
      e = e + -1 | 0;
      if (!e) {
       e = 0;
       break;
      }
     }
    }
   } while (0);
   return (e | 0 ? b : 0) | 0;
  }

  function Ka(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0;
   g = i;
   i = i + 16 | 0;
   h = g;
   j = g + 12 | 0;
   e = g + 8 | 0;
   f = g + 4 | 0;
   c[j >> 2] = b;
   c[e >> 2] = d;
   c[f >> 2] = a[86922] | 0 ? 86923 : 87442;
   Ee(86923, 0, 1038) | 0;
   a[86922] = 1 - (a[86922] | 0);
   b = c[f >> 2] | 0;
   c[h >> 2] = c[j >> 2];
   Dd(b, 57952, h) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 1 | 0) ye(b, 57959) | 0; else ye(b, 57965) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 8 | 0) ye(b, 57971) | 0; else ye(b, 57976) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 32 | 0) ye(b, 57981) | 0; else ye(b, 57976) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 80 | 0) ye(b, 57986) | 0; else ye(b, 63382) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 64 | 0) ye(b, 57988) | 0; else ye(b, 63382) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 16 | 0) ye(b, 57990) | 0; else ye(b, 63382) | 0;
   b = c[f >> 2] | 0;
   if (c[e >> 2] & 80 | 0) {
    ye(b, 57992) | 0;
    j = c[f >> 2] | 0;
    i = g;
    return j | 0;
   } else {
    ye(b, 63382) | 0;
    j = c[f >> 2] | 0;
    i = g;
    return j | 0;
   }
   return 0;
  }

  function zc() {
   var b = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   b = f;
   if (a[1092353] & 1) {
    e = c[18881] | 0;
    c[b >> 2] = c[18880];
    c[b + 4 >> 2] = e;
    ve(62115, b) | 0;
   }
   if ((c[18881] | 0) <= (c[18879] | 0)) {
    Ya(5, 0, 0) | 0;
    c[18881] = c[18879];
    i = f;
    return;
   }
   c[18881] = (c[18881] | 0) + -1;
   b = c[18880] | 0;
   e = c[18878] | 0;
   if ((c[75532 + (c[18881] << 2) >> 2] | 0) == 128) if ((b | 0) < (e + 1 | 0)) {
    Ya(5, 0, 0) | 0;
    c[18880] = c[18878];
    i = f;
    return;
   } else {
    c[18880] = (c[18880] | 0) + -1;
    ya[c[76172 + (c[18881] << 2) >> 2] & 63](c[75660 + (c[18880] << 2) >> 2] | 0, d[1092356 + (c[18880] | 0) >> 0] | 0);
    i = f;
    return;
   } else if ((b | 0) < (e + 2 | 0)) {
    Ya(5, 0, 0) | 0;
    c[18880] = c[18878];
    i = f;
    return;
   } else {
    c[18880] = (c[18880] | 0) - 2;
    Ba[c[76172 + (c[18881] << 2) >> 2] & 31](c[75660 + (c[18880] << 2) >> 2] | 0, c[75660 + ((c[18880] | 0) + 1 << 2) >> 2] | 0, d[1092356 + (c[18880] | 0) >> 0] | 0, d[1092356 + ((c[18880] | 0) + 1) >> 0] | 0);
    i = f;
    return;
   }
  }

  function $b(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 32 | 0;
   h = j + 8 | 0;
   g = j;
   e = j + 16 | 0;
   f = j + 12 | 0;
   c[e >> 2] = b;
   c[f >> 2] = d;
   if (a[1092353] & 1) xe(62183) | 0;
   c[18882] = 1;
   if ((c[f >> 2] | 0) == 128 ? 1 : (c[18881] | 0) == (c[18879] | 0)) {
    if (a[1092353] & 1) {
     c[g >> 2] = c[18881];
     ve(62188, g) | 0;
    }
    c[76172 + (c[18881] << 2) >> 2] = c[e >> 2];
    c[75532 + (c[18881] << 2) >> 2] = c[f >> 2];
    c[18881] = (c[18881] | 0) + 1;
    i = j;
    return;
   }
   while (1) {
    if ((c[18881] | 0) == (c[18879] | 0)) break;
    if (!(c[75532 + ((c[18881] | 0) - 1 << 2) >> 2] | 0)) break;
    if ((c[f >> 2] | 0) > (c[75532 + ((c[18881] | 0) - 1 << 2) >> 2] | 0)) break;
    zc();
   }
   if (a[1092353] & 1) {
    c[h >> 2] = c[18881];
    ve(62205, h) | 0;
   }
   c[76172 + (c[18881] << 2) >> 2] = c[e >> 2];
   c[75532 + (c[18881] << 2) >> 2] = c[f >> 2];
   c[18881] = (c[18881] | 0) + 1;
   if ((c[18881] | 0) != 32) {
    i = j;
    return;
   }
   xe(62216) | 0;
   c[18881] = c[18879];
   i = j;
   return;
  }

  function nd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0;
   m = i;
   i = i + 48 | 0;
   h = m + 16 | 0;
   g = m;
   f = m + 32 | 0;
   c[f >> 2] = d;
   j = f + 4 | 0;
   l = b + 48 | 0;
   n = c[l >> 2] | 0;
   c[j >> 2] = e - ((n | 0) != 0 & 1);
   k = b + 44 | 0;
   c[f + 8 >> 2] = c[k >> 2];
   c[f + 12 >> 2] = n;
   if (!(c[19094] | 0)) {
    c[h >> 2] = c[b + 60 >> 2];
    c[h + 4 >> 2] = f;
    c[h + 8 >> 2] = 2;
    f = jd(ta(145, h | 0) | 0) | 0;
   } else {
    ra(2, b | 0);
    c[g >> 2] = c[b + 60 >> 2];
    c[g + 4 >> 2] = f;
    c[g + 8 >> 2] = 2;
    f = jd(ta(145, g | 0) | 0) | 0;
    fa(0);
   }
   if ((f | 0) < 1) {
    c[b >> 2] = c[b >> 2] | f & 48 ^ 16;
    c[b + 8 >> 2] = 0;
    c[b + 4 >> 2] = 0;
   } else {
    j = c[j >> 2] | 0;
    if (f >>> 0 > j >>> 0) {
     g = c[k >> 2] | 0;
     h = b + 4 | 0;
     c[h >> 2] = g;
     c[b + 8 >> 2] = g + (f - j);
     if (!(c[l >> 2] | 0)) f = e; else {
      c[h >> 2] = g + 1;
      a[d + (e + -1) >> 0] = a[g >> 0] | 0;
      f = e;
     }
    }
   }
   i = m;
   return f | 0;
  }

  function $a(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0;
   l = i;
   i = i + 48 | 0;
   k = l + 32 | 0;
   j = l + 16 | 0;
   h = l;
   e = l + 44 | 0;
   f = l + 40 | 0;
   g = l + 36 | 0;
   c[e >> 2] = b;
   b = tb(c[e >> 2] | 0, 58352) | 0;
   c[g >> 2] = b;
   if (!b) {
    c[k >> 2] = c[e >> 2];
    ve(58414, k) | 0;
    i = l;
    return;
   }
   if ((d[1092354] | 0) > 1) if ((d[1092354] | 0) != 5) {
    k = c[e >> 2] | 0;
    c[h >> 2] = a[1092352] << 2;
    c[h + 4 >> 2] = 87961;
    c[h + 8 >> 2] = k;
    ve(58354, h) | 0;
   }
   a[1092352] = (a[1092352] | 0) + 1 << 24 >> 24;
   if (c[18872] | 0) {
    k = c[18874] | 0;
    b = a[1092352] | 0;
    h = c[16541] | 0;
    c[j >> 2] = c[e >> 2];
    c[j + 4 >> 2] = b;
    c[j + 8 >> 2] = h;
    le(k, 58380, j) | 0;
   }
   c[f >> 2] = ab(36) | 0;
   c[c[f >> 2] >> 2] = c[18604];
   k = bb((Zd(c[e >> 2] | 0) | 0) + 1 | 0) | 0;
   k = $d(k, c[e >> 2] | 0) | 0;
   c[(c[f >> 2] | 0) + 4 >> 2] = k;
   c[(c[f >> 2] | 0) + 8 >> 2] = c[g >> 2];
   c[(c[f >> 2] | 0) + 12 >> 2] = 0;
   c[18604] = c[f >> 2];
   i = l;
   return;
  }

  function _a(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 96 | 0;
   e = j + 92 | 0;
   f = j + 88 | 0;
   g = j + 84 | 0;
   h = j;
   c[e >> 2] = a;
   while (1) {
    if (!(c[(c[e >> 2] | 0) + 4 >> 2] | 0)) break;
    a = h;
    b = (c[e >> 2] | 0) + 20 | 0;
    d = a + 84 | 0;
    do {
     c[a >> 2] = c[b >> 2];
     a = a + 4 | 0;
     b = b + 4 | 0;
    } while ((a | 0) < (d | 0));
    c[g >> 2] = 0;
    c[f >> 2] = 0;
    while (1) {
     if ((c[f >> 2] | 0) >= 21) break;
     c[(c[e >> 2] | 0) + 20 + (c[f >> 2] << 2) >> 2] = 0;
     if (c[(c[e >> 2] | 0) + 16 >> 2] & 1 << c[f >> 2] | 0) {
      d = c[g >> 2] | 0;
      c[g >> 2] = d + 1;
      c[(c[e >> 2] | 0) + 20 + (c[f >> 2] << 2) >> 2] = c[h + (d << 2) >> 2];
     }
     c[f >> 2] = (c[f >> 2] | 0) + 1;
    }
    c[f >> 2] = Sa(c[(c[e >> 2] | 0) + 8 >> 2] | 0) | 0;
    c[c[e >> 2] >> 2] = c[70320 + (c[f >> 2] << 2) >> 2];
    c[70320 + (c[f >> 2] << 2) >> 2] = c[e >> 2];
    c[e >> 2] = (c[e >> 2] | 0) + 104;
   }
   i = j;
   return;
  }

  function jb() {
   var a = 0, b = 0, e = 0, f = 0, g = 0, h = 0, j = 0, k = 0;
   h = i;
   i = i + 48 | 0;
   g = h + 16 | 0;
   f = h + 8 | 0;
   a = h + 32 | 0;
   b = h + 28 | 0;
   e = h + 24 | 0;
   c[e >> 2] = kb() | 0;
   if (!(c[e >> 2] | 0)) {
    g = c[e >> 2] | 0;
    i = h;
    return g | 0;
   }
   ve(60098, h) | 0;
   c[b >> 2] = 0;
   while (1) {
    if ((c[b >> 2] | 0) >= 1024) break;
    c[a >> 2] = c[66224 + (c[b >> 2] << 2) >> 2];
    while (1) {
     if (!(c[a >> 2] | 0)) break;
     if ((d[(c[a >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) {
      k = c[(c[a >> 2] | 0) + 4 >> 2] | 0;
      j = Ka(c[(c[a >> 2] | 0) + 16 >> 2] | 0, d[(c[a >> 2] | 0) + 12 >> 0] | 0) | 0;
      c[f >> 2] = k;
      c[f + 4 >> 2] = j;
      ve(58575, f) | 0;
     }
     c[a >> 2] = c[c[a >> 2] >> 2];
    }
    c[b >> 2] = (c[b >> 2] | 0) + 1;
   }
   k = (c[e >> 2] | 0) == 1 ? 32 : 115;
   c[g >> 2] = c[e >> 2];
   c[g + 4 >> 2] = k;
   ve(60126, g) | 0;
   k = c[e >> 2] | 0;
   i = h;
   return k | 0;
  }

  function vb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 16 | 0;
   f = j + 8 | 0;
   g = j;
   c[f >> 2] = b;
   c[j + 4 >> 2] = e;
   c[g >> 2] = c[18606];
   while (1) {
    if (!(c[g >> 2] | 0)) break;
    e = (Ad(c[f >> 2] | 0, c[(c[g >> 2] | 0) + 4 >> 2] | 0) | 0) == 0;
    b = c[g >> 2] | 0;
    if (e) {
     h = 4;
     break;
    }
    c[g >> 2] = c[b >> 2];
   }
   if ((h | 0) == 4) {
    c[18607] = b;
    Mc();
    i = j;
    return;
   }
   h = ab(32) | 0;
   c[g >> 2] = h;
   c[18607] = h;
   c[c[g >> 2] >> 2] = c[18606];
   h = bb((Zd(c[f >> 2] | 0) | 0) + 1 | 0) | 0;
   h = $d(h, c[f >> 2] | 0) | 0;
   c[(c[g >> 2] | 0) + 4 >> 2] = h;
   a[(c[g >> 2] | 0) + 29 >> 0] = 1;
   a[(c[g >> 2] | 0) + 28 >> 0] = 1;
   a[(c[g >> 2] | 0) + 9 >> 0] = 1;
   a[(c[g >> 2] | 0) + 8 >> 0] = 1;
   c[18606] = c[g >> 2];
   if ((c[18865] | 0) == 20) {
    h = (c[g >> 2] | 0) + 8 | 0;
    a[h >> 0] = d[h >> 0] | 0 | 16;
   }
   Mc();
   i = j;
   return;
  }

  function Cb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0;
   g = i;
   i = i + 16 | 0;
   h = g + 8 | 0;
   f = g;
   c[h >> 2] = b;
   c[g + 4 >> 2] = e;
   c[f >> 2] = Zb(c[h >> 2] | 0, 0) | 0;
   c[(c[18607] | 0) + 12 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
   b = (c[18607] | 0) + 8 | 0;
   e = d[b >> 0] | 0;
   if ((d[(c[f >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) a[b >> 0] = e | 1; else a[b >> 0] = e & -2;
   if ((d[(c[18607] | 0) + 28 >> 0] | 0) & 1 | 0) {
    c[(c[18607] | 0) + 20 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
    a[(c[18607] | 0) + 28 >> 0] = a[(c[f >> 2] | 0) + 12 >> 0] | 0;
   }
   if (!(c[c[f >> 2] >> 2] | 0)) {
    Mc();
    h = c[f >> 2] | 0;
    Nc(h);
    i = g;
    return;
   }
   a[61260] = c[(c[c[f >> 2] >> 2] | 0) + 16 >> 2];
   if (!((d[(c[c[f >> 2] >> 2] | 0) + 12 >> 0] | 0) & 1)) {
    Mc();
    h = c[f >> 2] | 0;
    Nc(h);
    i = g;
    return;
   }
   Ya(23, 1, 0) | 0;
   Mc();
   h = c[f >> 2] | 0;
   Nc(h);
   i = g;
   return;
  }

  function Jb(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   k = i;
   i = i + 304 | 0;
   j = k + 16 | 0;
   h = k + 8 | 0;
   g = k;
   m = k + 32 | 0;
   l = k + 24 | 0;
   e = k + 20 | 0;
   f = k + 40 | 0;
   c[m >> 2] = a;
   c[k + 28 >> 2] = b;
   c[l >> 2] = Zb(c[m >> 2] | 0, 0) | 0;
   c[e >> 2] = c[l >> 2];
   while (1) {
    if (!(c[e >> 2] | 0)) break;
    if (!((d[(c[e >> 2] | 0) + 12 >> 0] | 0) & 1)) {
     a = c[e >> 2] | 0;
     if ((d[(c[e >> 2] | 0) + 12 >> 0] | 0) & 40 | 0) {
      c[g >> 2] = c[a + 8 >> 2];
      Dd(f, 62023, g) | 0;
     } else {
      c[h >> 2] = c[a + 16 >> 2];
      Dd(f, 61718, h) | 0;
     }
     if (c[18874] | 0) {
      m = c[18874] | 0;
      c[j >> 2] = f;
      le(m, 61723, j) | 0;
     }
     Ja(63382);
     Ja(f);
    }
    c[e >> 2] = c[c[e >> 2] >> 2];
   }
   Ja(61727);
   if (!(c[18874] | 0)) {
    i = k;
    return;
   }
   we(10, c[18874] | 0) | 0;
   i = k;
   return;
  }

  function Ra(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 96 | 0;
   d = j + 8 | 0;
   e = j + 4 | 0;
   f = j + 80 | 0;
   h = j;
   g = j + 16 | 0;
   c[d >> 2] = b;
   if ((a[c[d >> 2] >> 0] | 0) == 46) c[d >> 2] = (c[d >> 2] | 0) + 1;
   c[e >> 2] = 0;
   while (1) {
    b = a[(c[d >> 2] | 0) + (c[e >> 2] | 0) >> 0] | 0;
    a[f >> 0] = b;
    if (!(b << 24 >> 24)) break;
    if ((a[f >> 0] | 0) >= 65) if ((a[f >> 0] | 0) <= 90) a[f >> 0] = (a[f >> 0] | 0) + 32;
    a[g + (c[e >> 2] | 0) >> 0] = a[f >> 0] | 0;
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   a[g + (c[e >> 2] | 0) >> 0] = 0;
   c[h >> 2] = c[70320 + ((Sa(g) | 0) << 2) >> 2];
   while (1) {
    if (!(c[h >> 2] | 0)) {
     b = 13;
     break;
    }
    if (!(Ad(g, c[(c[h >> 2] | 0) + 8 >> 2] | 0) | 0)) {
     b = 13;
     break;
    }
    c[h >> 2] = c[c[h >> 2] >> 2];
   }
   if ((b | 0) == 13) {
    i = j;
    return c[h >> 2] | 0;
   }
   return 0;
  }

  function Jd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, i = 0;
   f = e + 16 | 0;
   g = c[f >> 2] | 0;
   if (!g) if (!(Td(e) | 0)) {
    f = c[f >> 2] | 0;
    h = 5;
   } else f = 0; else {
    f = g;
    h = 5;
   }
   a : do if ((h | 0) == 5) {
    i = e + 20 | 0;
    h = c[i >> 2] | 0;
    g = h;
    if ((f - h | 0) >>> 0 < d >>> 0) {
     f = wa[c[e + 36 >> 2] & 7](e, b, d) | 0;
     break;
    }
    b : do if ((a[e + 75 >> 0] | 0) > -1) {
     f = d;
     while (1) {
      if (!f) {
       h = d;
       f = 0;
       break b;
      }
      h = f + -1 | 0;
      if ((a[b + h >> 0] | 0) == 10) break; else f = h;
     }
     if ((wa[c[e + 36 >> 2] & 7](e, b, f) | 0) >>> 0 < f >>> 0) break a;
     h = d - f | 0;
     b = b + f | 0;
     g = c[i >> 2] | 0;
    } else {
     h = d;
     f = 0;
    } while (0);
    Ne(g | 0, b | 0, h | 0) | 0;
    c[i >> 2] = (c[i >> 2] | 0) + h;
    f = f + h | 0;
   } while (0);
   return f | 0;
  }

  function Ab(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 32 | 0;
   e = j + 16 | 0;
   f = j + 8 | 0;
   g = j + 4 | 0;
   h = j;
   c[e >> 2] = a;
   c[j + 12 >> 2] = b;
   c[g >> 2] = 1;
   c[h >> 2] = 0;
   if ((c[18865] | 0) == 6) c[g >> 2] = 2;
   if ((c[18865] | 0) == 19) c[g >> 2] = 4;
   Mc();
   e = Zb(c[e >> 2] | 0, 0) | 0;
   c[f >> 2] = e;
   if (!e) {
    i = j;
    return;
   }
   if (c[c[f >> 2] >> 2] | 0) c[h >> 2] = c[(c[c[f >> 2] >> 2] | 0) + 16 >> 2];
   if ((d[(c[f >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) {
    c[16552] = (c[16552] | 0) + 1;
    c[16550] = c[16550] | 32;
   } else {
    if (c[c[f >> 2] >> 2] | 0) if ((d[(c[c[f >> 2] >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 32;
    }
    Bb(c[h >> 2] | 0, c[(c[f >> 2] | 0) + 16 >> 2] | 0, c[g >> 2] | 0);
   }
   Nc(c[f >> 2] | 0);
   i = j;
   return;
  }

  function te(b, d, e, f) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, i = 0, j = 0, k = 0, l = 0;
   k = S(e, d) | 0;
   if ((c[f + 76 >> 2] | 0) > -1) j = Id(f) | 0; else j = 0;
   g = f + 74 | 0;
   i = a[g >> 0] | 0;
   a[g >> 0] = i + 255 | i;
   g = f + 4 | 0;
   i = c[g >> 2] | 0;
   h = (c[f + 8 >> 2] | 0) - i | 0;
   if ((h | 0) > 0) {
    h = h >>> 0 < k >>> 0 ? h : k;
    Ne(b | 0, i | 0, h | 0) | 0;
    c[g >> 2] = i + h;
    g = k - h | 0;
    b = b + h | 0;
   } else g = k;
   a : do if (!g) l = 13; else {
    i = f + 32 | 0;
    while (1) {
     if (yd(f) | 0) break;
     h = wa[c[i >> 2] & 7](f, b, g) | 0;
     if ((h + 1 | 0) >>> 0 < 2) break;
     g = g - h | 0;
     if (!g) {
      l = 13;
      break a;
     } else b = b + h | 0;
    }
    if (j | 0) md(f);
    e = ((k - g | 0) >>> 0) / (d >>> 0) | 0;
   } while (0);
   if ((l | 0) == 13) if (j) md(f);
   return e | 0;
  }

  function vd(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, i = 0, j = 0;
   f = b + 104 | 0;
   e = c[f >> 2] | 0;
   if (!e) j = 3; else if ((c[b + 108 >> 2] | 0) < (e | 0)) j = 3; else j = 4;
   if ((j | 0) == 3) {
    e = xd(b) | 0;
    if ((e | 0) < 0) j = 4; else {
     f = c[f >> 2] | 0;
     i = c[b + 8 >> 2] | 0;
     if (!f) {
      g = i;
      j = 9;
     } else {
      h = c[b + 4 >> 2] | 0;
      f = f - (c[b + 108 >> 2] | 0) | 0;
      g = i;
      if ((i - h | 0) < (f | 0)) j = 9; else c[b + 100 >> 2] = h + (f + -1);
     }
     if ((j | 0) == 9) c[b + 100 >> 2] = i;
     f = b + 4 | 0;
     if (!g) f = c[f >> 2] | 0; else {
      f = c[f >> 2] | 0;
      b = b + 108 | 0;
      c[b >> 2] = g + 1 - f + (c[b >> 2] | 0);
     }
     f = f + -1 | 0;
     if ((d[f >> 0] | 0 | 0) != (e | 0)) a[f >> 0] = e;
    }
   }
   if ((j | 0) == 4) {
    c[b + 100 >> 2] = 0;
    e = -1;
   }
   return e | 0;
  }

  function tb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 32 | 0;
   d = k + 20 | 0;
   e = k + 16 | 0;
   f = k + 12 | 0;
   g = k + 8 | 0;
   h = k + 4 | 0;
   j = k;
   c[e >> 2] = a;
   c[f >> 2] = b;
   c[g >> 2] = de(c[e >> 2] | 0, c[f >> 2] | 0) | 0;
   if (c[g >> 2] | 0) {
    c[d >> 2] = c[g >> 2];
    j = c[d >> 2] | 0;
    i = k;
    return j | 0;
   }
   if (be(c[e >> 2] | 0, 58) | 0) {
    c[d >> 2] = 0;
    j = c[d >> 2] | 0;
    i = k;
    return j | 0;
   }
   c[j >> 2] = ab(512) | 0;
   c[h >> 2] = c[16545];
   while (1) {
    if (!(c[h >> 2] | 0)) break;
    ub(c[j >> 2] | 0, (c[h >> 2] | 0) + 4 | 0, c[e >> 2] | 0);
    c[g >> 2] = de(c[j >> 2] | 0, c[f >> 2] | 0) | 0;
    if (c[g >> 2] | 0) break;
    c[h >> 2] = c[c[h >> 2] >> 2];
   }
   Ae(c[j >> 2] | 0);
   c[d >> 2] = c[g >> 2];
   j = c[d >> 2] | 0;
   i = k;
   return j | 0;
  }

  function Db(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0;
   g = i;
   i = i + 16 | 0;
   h = g + 8 | 0;
   f = g;
   c[h >> 2] = b;
   c[g + 4 >> 2] = e;
   c[f >> 2] = Zb(c[h >> 2] | 0, 0) | 0;
   e = (c[18607] | 0) + 8 | 0;
   a[e >> 0] = d[e >> 0] | 0 | 32;
   if (!(d[(c[f >> 2] | 0) + 13 >> 0] | 0)) {
    Mc();
    h = c[f >> 2] | 0;
    Nc(h);
    i = g;
    return;
   }
   c[(c[18607] | 0) + 16 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
   b = (c[18607] | 0) + 9 | 0;
   e = d[b >> 0] | 0;
   if ((d[(c[f >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) a[b >> 0] = e | 1; else a[b >> 0] = e & -2;
   if (!((d[(c[18607] | 0) + 29 >> 0] | 0) & 1)) {
    Mc();
    h = c[f >> 2] | 0;
    Nc(h);
    i = g;
    return;
   }
   c[(c[18607] | 0) + 24 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
   a[(c[18607] | 0) + 29 >> 0] = a[(c[f >> 2] | 0) + 12 >> 0] | 0;
   Mc();
   h = c[f >> 2] | 0;
   Nc(h);
   i = g;
   return;
  }

  function wb(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 16 | 0;
   e = h + 12 | 0;
   f = h + 4 | 0;
   g = h;
   c[e >> 2] = b;
   c[h + 8 >> 2] = d;
   Mc();
   c[16544] = 0;
   c[f >> 2] = 0;
   while (1) {
    if (!(a[(c[e >> 2] | 0) + (c[f >> 2] | 0) >> 0] | 0)) {
     b = 7;
     break;
    }
    if ((a[(c[e >> 2] | 0) + (c[f >> 2] | 0) >> 0] | 0) != 32) {
     d = (xb(a[(c[e >> 2] | 0) + (c[f >> 2] | 0) >> 0] | 0) | 0) << 4;
     c[g >> 2] = d + (xb(a[(c[e >> 2] | 0) + ((c[f >> 2] | 0) + 1) >> 0] | 0) | 0);
     d = (c[f >> 2] | 0) + 1 | 0;
     c[f >> 2] = d;
     if (!(a[(c[e >> 2] | 0) + d >> 0] | 0)) {
      b = 7;
      break;
     }
     b = c[g >> 2] & 255;
     d = c[16544] | 0;
     c[16544] = d + 1;
     a[1091574 + d >> 0] = b;
    }
    c[f >> 2] = (c[f >> 2] | 0) + 1;
   }
   if ((b | 0) == 7) {
    nb();
    i = h;
    return;
   }
  }

  function Bc(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 4 | 0;
   e = g;
   c[d >> 2] = b;
   c[e >> 2] = 0;
   while (1) {
    if ((a[c[d >> 2] >> 0] | 0) >= 48) if ((a[c[d >> 2] >> 0] | 0) <= 57) c[e >> 2] = (c[e >> 2] << 4) + ((a[c[d >> 2] >> 0] | 0) - 48); else f = 5; else f = 5;
    if ((f | 0) == 5) {
     f = 0;
     if ((a[c[d >> 2] >> 0] | 0) >= 97) {
      if ((a[c[d >> 2] >> 0] | 0) > 102) f = 7;
     } else f = 7;
     if ((f | 0) == 7) {
      f = 0;
      if ((a[c[d >> 2] >> 0] | 0) < 65) {
       f = 11;
       break;
      }
      if ((a[c[d >> 2] >> 0] | 0) > 70) {
       f = 11;
       break;
      }
     }
     c[e >> 2] = (c[e >> 2] << 4) + ((a[c[d >> 2] >> 0] & 31) + 9);
    }
    c[d >> 2] = (c[d >> 2] | 0) + 1;
   }
   if ((f | 0) == 11) {
    Gc(c[e >> 2] | 0, 0, 0);
    i = g;
    return c[d >> 2] | 0;
   }
   return 0;
  }

  function Wb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0;
   f = i;
   i = i + 16 | 0;
   c[f + 4 >> 2] = b;
   c[f >> 2] = e;
   if (a[(c[18608] | 0) + 9 >> 0] | 0) if (a[(c[18608] | 0) + 10 >> 0] | 0) {
    if (c[18605] | 0) if ((c[(c[18605] | 0) + 16 >> 2] | 0) == (c[18604] | 0)) {
     if (!(d[(c[18605] | 0) + 20 >> 0] | 0)) {
      b = (c[18605] | 0) + 4 | 0;
      e = (c[b >> 2] | 0) + -1 | 0;
      c[b >> 2] = e;
      if (e | 0) {
       if (d[(c[18604] | 0) + 16 >> 0] & 1 | 0) c[(c[18604] | 0) + 24 >> 2] = c[(c[18605] | 0) + 8 >> 2]; else ke(c[(c[18604] | 0) + 8 >> 2] | 0, c[(c[18605] | 0) + 8 >> 2] | 0, 0) | 0;
       c[(c[18604] | 0) + 12 >> 2] = c[(c[18605] | 0) + 12 >> 2];
       i = f;
       return;
      }
     }
     Pa(74420, 24);
     Ub(0, 0);
     i = f;
     return;
    }
    xe(61790) | 0;
    i = f;
    return;
   }
   Ub(0, 0);
   i = f;
   return;
  }

  function Fd(b, d, e, f) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0;
   n = i;
   i = i + 128 | 0;
   g = n + 112 | 0;
   m = n;
   h = m;
   j = 56868;
   k = h + 112 | 0;
   do {
    c[h >> 2] = c[j >> 2];
    h = h + 4 | 0;
    j = j + 4 | 0;
   } while ((h | 0) < (k | 0));
   if ((d + -1 | 0) >>> 0 > 2147483646) if (!d) {
    b = g;
    d = 1;
    l = 4;
   } else {
    c[(kd() | 0) >> 2] = 75;
    d = -1;
   } else l = 4;
   if ((l | 0) == 4) {
    l = -2 - b | 0;
    l = d >>> 0 > l >>> 0 ? l : d;
    c[m + 48 >> 2] = l;
    g = m + 20 | 0;
    c[g >> 2] = b;
    c[m + 44 >> 2] = b;
    d = b + l | 0;
    b = m + 16 | 0;
    c[b >> 2] = d;
    c[m + 28 >> 2] = d;
    d = Gd(m, e, f) | 0;
    if (l) {
     m = c[g >> 2] | 0;
     a[m + (((m | 0) == (c[b >> 2] | 0)) << 31 >> 31) >> 0] = 0;
    }
   }
   i = n;
   return d | 0;
  }

  function ce(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   f = d & 255;
   a : do if (!f) b = b + (Zd(b) | 0) | 0; else {
    if (b & 3) {
     e = d & 255;
     do {
      g = a[b >> 0] | 0;
      if (g << 24 >> 24 == 0 ? 1 : g << 24 >> 24 == e << 24 >> 24) break a;
      b = b + 1 | 0;
     } while ((b & 3 | 0) != 0);
    }
    f = S(f, 16843009) | 0;
    e = c[b >> 2] | 0;
    b : do if (!((e & -2139062144 ^ -2139062144) & e + -16843009)) do {
     g = e ^ f;
     if ((g & -2139062144 ^ -2139062144) & g + -16843009 | 0) break b;
     b = b + 4 | 0;
     e = c[b >> 2] | 0;
    } while (!((e & -2139062144 ^ -2139062144) & e + -16843009 | 0)); while (0);
    e = d & 255;
    while (1) {
     g = a[b >> 0] | 0;
     if (g << 24 >> 24 == 0 ? 1 : g << 24 >> 24 == e << 24 >> 24) break; else b = b + 1 | 0;
    }
   } while (0);
   return b | 0;
  }

  function xb(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 80 | 0;
   g = h;
   d = h + 8 | 0;
   e = h + 4 | 0;
   f = h + 16 | 0;
   c[e >> 2] = a;
   b = c[e >> 2] | 0;
   if ((c[e >> 2] | 0) >= 48 & (c[e >> 2] | 0) <= 57) {
    c[d >> 2] = b - 48;
    g = c[d >> 2] | 0;
    i = h;
    return g | 0;
   }
   a = c[e >> 2] | 0;
   if ((b | 0) >= 97 & (c[e >> 2] | 0) <= 102) {
    c[d >> 2] = a - 97 + 10;
    g = c[d >> 2] | 0;
    i = h;
    return g | 0;
   }
   if ((a | 0) >= 65 & (c[e >> 2] | 0) <= 70) {
    c[d >> 2] = (c[e >> 2] | 0) - 65 + 10;
    g = c[d >> 2] | 0;
    i = h;
    return g | 0;
   }
   c[g >> 2] = c[e >> 2];
   Dd(f, 61552, g) | 0;
   Ya(5, 0, f) | 0;
   xe(61569) | 0;
   if (c[18872] | 0) re(61597, c[18874] | 0) | 0;
   c[d >> 2] = 0;
   g = c[d >> 2] | 0;
   i = h;
   return g | 0;
  }

  function ae(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = d;
   a : do if (!((e ^ b) & 3)) {
    if (e & 3) do {
     e = a[d >> 0] | 0;
     a[b >> 0] = e;
     if (!(e << 24 >> 24)) break a;
     d = d + 1 | 0;
     b = b + 1 | 0;
    } while ((d & 3 | 0) != 0);
    e = c[d >> 2] | 0;
    if (!((e & -2139062144 ^ -2139062144) & e + -16843009)) {
     f = b;
     while (1) {
      d = d + 4 | 0;
      b = f + 4 | 0;
      c[f >> 2] = e;
      e = c[d >> 2] | 0;
      if ((e & -2139062144 ^ -2139062144) & e + -16843009 | 0) break; else f = b;
     }
    }
    f = 8;
   } else f = 8; while (0);
   if ((f | 0) == 8) {
    f = a[d >> 0] | 0;
    a[b >> 0] = f;
    if (f << 24 >> 24) do {
     d = d + 1 | 0;
     b = b + 1 | 0;
     f = a[d >> 0] | 0;
     a[b >> 0] = f;
    } while (f << 24 >> 24 != 0);
   }
   return b | 0;
  }

  function Wd(a, b, d, e, f) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0, n = 0;
   n = i;
   i = i + 240 | 0;
   m = n;
   c[m >> 2] = a;
   a : do if ((e | 0) > 1) {
    l = 0 - b | 0;
    g = a;
    k = e;
    e = 1;
    while (1) {
     h = g + l | 0;
     j = k + -2 | 0;
     g = h + (0 - (c[f + (j << 2) >> 2] | 0)) | 0;
     if ((Aa[d & 3](a, g) | 0) > -1) if ((Aa[d & 3](a, h) | 0) > -1) break a;
     a = e + 1 | 0;
     e = m + (e << 2) | 0;
     if ((Aa[d & 3](g, h) | 0) > -1) {
      c[e >> 2] = g;
      e = k + -1 | 0;
     } else {
      c[e >> 2] = h;
      g = h;
      e = j;
     }
     if ((e | 0) <= 1) {
      e = a;
      break a;
     }
     k = e;
     e = a;
     a = c[m >> 2] | 0;
    }
   } else e = 1; while (0);
   Yd(b, m, e);
   i = n;
   return;
  }

  function sb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 32 | 0;
   g = h;
   d = h + 16 | 0;
   e = h + 8 | 0;
   f = h + 4 | 0;
   c[d >> 2] = a;
   c[h + 12 >> 2] = b;
   Mc();
   c[e >> 2] = rb(c[d >> 2] | 0) | 0;
   c[f >> 2] = tb(c[e >> 2] | 0, 61530) | 0;
   if (c[f >> 2] | 0) {
    a : do if (c[16552] | 0) {
     ke(c[f >> 2] | 0, 0, 2) | 0;
     c[16544] = ue(c[f >> 2] | 0) | 0;
     nb();
    } else while (1) {
     c[16544] = te(1091574, 1, 256, c[f >> 2] | 0) | 0;
     if ((c[16544] | 0) <= 0) break a;
     nb();
    } while (0);
    ge(c[f >> 2] | 0) | 0;
   } else {
    c[g >> 2] = c[e >> 2];
    ve(61533, g) | 0;
   }
   if ((c[e >> 2] | 0) == (c[d >> 2] | 0)) {
    c[16544] = 0;
    i = h;
    return;
   }
   Ae(c[e >> 2] | 0);
   c[16544] = 0;
   i = h;
   return;
  }

  function Sd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   do if (!b) b = 1; else {
    if (d >>> 0 < 128) {
     a[b >> 0] = d;
     b = 1;
     break;
    }
    if (d >>> 0 < 2048) {
     a[b >> 0] = d >>> 6 | 192;
     a[b + 1 >> 0] = d & 63 | 128;
     b = 2;
     break;
    }
    if (d >>> 0 < 55296 | (d & -8192 | 0) == 57344) {
     a[b >> 0] = d >>> 12 | 224;
     a[b + 1 >> 0] = d >>> 6 & 63 | 128;
     a[b + 2 >> 0] = d & 63 | 128;
     b = 3;
     break;
    }
    if ((d + -65536 | 0) >>> 0 < 1048576) {
     a[b >> 0] = d >>> 18 | 240;
     a[b + 1 >> 0] = d >>> 12 & 63 | 128;
     a[b + 2 >> 0] = d >>> 6 & 63 | 128;
     a[b + 3 >> 0] = d & 63 | 128;
     b = 4;
     break;
    } else {
     c[(kd() | 0) >> 2] = 84;
     b = -1;
     break;
    }
   } while (0);
   return b | 0;
  }

  function Xb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 32 | 0;
   d = j + 20 | 0;
   e = j + 12 | 0;
   f = j + 8 | 0;
   g = j + 4 | 0;
   h = j;
   c[d >> 2] = a;
   c[j + 16 >> 2] = b;
   c[g >> 2] = 0;
   c[f >> 2] = rb(c[d >> 2] | 0) | 0;
   c[e >> 2] = 66180;
   while (1) {
    if (!(c[c[e >> 2] >> 2] | 0)) break;
    if (!(Ad((c[c[e >> 2] >> 2] | 0) + 4 | 0, c[f >> 2] | 0) | 0)) c[g >> 2] = 1;
    c[e >> 2] = c[c[e >> 2] >> 2];
   }
   if (!(c[g >> 2] | 0)) {
    c[h >> 2] = Wa(5 + (Zd(c[f >> 2] | 0) | 0) | 0) | 0;
    $d((c[h >> 2] | 0) + 4 | 0, c[f >> 2] | 0) | 0;
    c[c[e >> 2] >> 2] = c[h >> 2];
   }
   if ((c[f >> 2] | 0) == (c[d >> 2] | 0)) {
    i = j;
    return;
   }
   Ae(c[f >> 2] | 0);
   i = j;
   return;
  }

  function cb(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   k = i;
   i = i + 48 | 0;
   j = k + 16 | 0;
   h = k + 8 | 0;
   g = k;
   m = k + 28 | 0;
   l = k + 24 | 0;
   e = k + 36 | 0;
   f = k + 20 | 0;
   c[k + 32 >> 2] = 0;
   c[m >> 2] = b;
   c[l >> 2] = d;
   a[e >> 0] = 0;
   c[f >> 2] = db(c[m >> 2] | 0, c[l >> 2] | 0, e) | 0;
   if (!(c[f >> 2] | 0)) {
    m = a[e >> 0] | 0;
    m = m & 1;
    eb(m);
    m = c[f >> 2] | 0;
    i = k;
    return m | 0;
   }
   a[76922] = 32;
   c[g >> 2] = 76922;
   ve(58110, g) | 0;
   c[h >> 2] = 89462;
   ve(58110, h) | 0;
   c[j >> 2] = c[8 + ((c[f >> 2] | 0) * 12 | 0) + 8 >> 2];
   ve(58444, j) | 0;
   m = a[e >> 0] | 0;
   m = m & 1;
   eb(m);
   m = c[f >> 2] | 0;
   i = k;
   return m | 0;
  }

  function Yc(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   e = k + 12 | 0;
   f = k + 8 | 0;
   g = k + 4 | 0;
   h = k;
   c[e >> 2] = a;
   c[f >> 2] = b;
   c[h >> 2] = 0;
   c[c[f >> 2] >> 2] = 0;
   c[g >> 2] = Zb(c[e >> 2] | 0, 0) | 0;
   do if (c[c[g >> 2] >> 2] | 0) j = 3; else if (3 != (d[(c[g >> 2] | 0) + 13 >> 0] | 0 | 0)) j = 3; else if ((d[(c[g >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) {
    c[16552] = (c[16552] | 0) + 1;
    c[16550] = c[16550] | 1;
    c[h >> 2] = 1;
    break;
   } else {
    c[c[f >> 2] >> 2] = c[(c[g >> 2] | 0) + 16 >> 2];
    break;
   } while (0);
   if ((j | 0) == 3) Ya(5, 1, c[e >> 2] | 0) | 0;
   Nc(c[g >> 2] | 0);
   i = k;
   return c[h >> 2] | 0;
  }

  function we(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   if ((c[d + 76 >> 2] | 0) < 0) g = 3; else if (!(Id(d) | 0)) g = 3; else {
    if ((a[d + 75 >> 0] | 0) == (b | 0)) g = 10; else {
     e = d + 20 | 0;
     f = c[e >> 2] | 0;
     if (f >>> 0 < (c[d + 16 >> 2] | 0) >>> 0) {
      c[e >> 2] = f + 1;
      a[f >> 0] = b;
      e = b & 255;
     } else g = 10;
    }
    if ((g | 0) == 10) e = oe(d, b) | 0;
    md(d);
   }
   do if ((g | 0) == 3) {
    if ((a[d + 75 >> 0] | 0) != (b | 0)) {
     e = d + 20 | 0;
     f = c[e >> 2] | 0;
     if (f >>> 0 < (c[d + 16 >> 2] | 0) >>> 0) {
      c[e >> 2] = f + 1;
      a[f >> 0] = b;
      e = b & 255;
      break;
     }
    }
    e = oe(d, b) | 0;
   } while (0);
   return e | 0;
  }

  function Kb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0;
   h = i;
   i = i + 16 | 0;
   j = h + 12 | 0;
   f = h + 4 | 0;
   g = h;
   c[j >> 2] = b;
   c[h + 8 >> 2] = e;
   c[f >> 2] = Zb(c[j >> 2] | 0, 0) | 0;
   e = c[18609] | 0;
   c[g >> 2] = Ic(e, Zd(c[18609] | 0) | 0) | 0;
   if (!(c[g >> 2] | 0)) {
    j = c[18609] | 0;
    c[g >> 2] = Kc(j, Zd(c[18609] | 0) | 0) | 0;
   }
   c[(c[g >> 2] | 0) + 16 >> 2] = c[(c[f >> 2] | 0) + 16 >> 2];
   a[(c[g >> 2] | 0) + 12 >> 0] = (d[(c[f >> 2] | 0) + 12 >> 0] | 0) & 9;
   c[(c[g >> 2] | 0) + 8 >> 2] = c[(c[f >> 2] | 0) + 8 >> 2];
   j = (c[f >> 2] | 0) + 12 | 0;
   a[j >> 0] = (d[j >> 0] | 0) & -41;
   Nc(c[f >> 2] | 0);
   i = h;
   return;
  }

  function Nb(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 32 | 0;
   e = h + 8 | 0;
   f = h + 4 | 0;
   g = h;
   c[h + 16 >> 2] = a;
   c[h + 12 >> 2] = b;
   c[e >> 2] = c[18604];
   if (!((d[(c[e >> 2] | 0) + 16 >> 0] | 0) & 1)) {
    xe(61754) | 0;
    i = h;
    return;
   }
   c[18866] = (c[18866] | 0) + -1;
   c[f >> 2] = c[(c[e >> 2] | 0) + 20 >> 2];
   while (1) {
    if (!(c[f >> 2] | 0)) break;
    c[g >> 2] = c[c[f >> 2] >> 2];
    Ae(c[f >> 2] | 0);
    c[f >> 2] = c[g >> 2];
   }
   c[18867] = c[(c[e >> 2] | 0) + 28 >> 2];
   c[18869] = c[(c[e >> 2] | 0) + 32 >> 2];
   c[18604] = c[c[e >> 2] >> 2];
   Ae(c[e >> 2] | 0);
   i = h;
   return;
  }

  function pb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   f = g + 4 | 0;
   c[f >> 2] = b;
   c[g >> 2] = e;
   Mc();
   c[16544] = 0;
   if (Cd(c[f >> 2] | 0, 61488, 7) | 0) if (Cd(c[f >> 2] | 0, 61497, 7) | 0) {
    if (Cd(c[f >> 2] | 0, 61506, 7) | 0) if (Cd(c[f >> 2] | 0, 61514, 7) | 0) {
     if (Cd(c[f >> 2] | 0, 61522, 2) | 0) if (Cd(c[f >> 2] | 0, 61526, 2) | 0) {
      a[61801] = 1;
      i = g;
      return;
     }
     a[61801] = 0;
     i = g;
     return;
    }
    f = (c[18604] | 0) + 16 | 0;
    a[f >> 0] = (d[f >> 0] | 0) & -3;
    i = g;
    return;
   }
   f = (c[18604] | 0) + 16 | 0;
   a[f >> 0] = d[f >> 0] | 0 | 2;
   i = g;
   return;
  }

  function ub(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   j = i;
   i = i + 16 | 0;
   f = j + 12 | 0;
   k = j + 8 | 0;
   g = j + 4 | 0;
   h = j;
   c[f >> 2] = b;
   c[k >> 2] = d;
   c[g >> 2] = e;
   $d(c[f >> 2] | 0, c[k >> 2] | 0) | 0;
   c[h >> 2] = Zd(c[f >> 2] | 0) | 0;
   if ((c[h >> 2] | 0) > 0) if ((a[(c[f >> 2] | 0) + ((c[h >> 2] | 0) - 1) >> 0] | 0) != 58) if ((a[(c[f >> 2] | 0) + ((c[h >> 2] | 0) - 1) >> 0] | 0) != 47) {
    a[(c[f >> 2] | 0) + (c[h >> 2] | 0) >> 0] = 47;
    c[h >> 2] = (c[h >> 2] | 0) + 1;
   }
   $d((c[f >> 2] | 0) + (c[h >> 2] | 0) | 0, c[g >> 2] | 0) | 0;
   i = j;
   return;
  }

  function rb(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[e >> 2] = b;
   b = c[e >> 2] | 0;
   if ((a[c[e >> 2] >> 0] | 0) != 34) {
    c[d >> 2] = b;
    f = c[d >> 2] | 0;
    i = g;
    return f | 0;
   }
   c[e >> 2] = b + 1;
   c[f >> 2] = bb((Zd(c[e >> 2] | 0) | 0) + 1 | 0) | 0;
   $d(c[f >> 2] | 0, c[e >> 2] | 0) | 0;
   c[e >> 2] = c[f >> 2];
   while (1) {
    if (!(a[c[e >> 2] >> 0] | 0)) break;
    if ((a[c[e >> 2] >> 0] | 0) == 34) break;
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   a[c[e >> 2] >> 0] = 0;
   c[d >> 2] = c[f >> 2];
   f = c[d >> 2] | 0;
   i = g;
   return f | 0;
  }

  function Ib(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0;
   j = i;
   i = i + 16 | 0;
   f = j + 12 | 0;
   g = j + 4 | 0;
   h = j;
   c[f >> 2] = b;
   c[j + 8 >> 2] = e;
   c[h >> 2] = Zd(c[18609] | 0) | 0;
   e = Ic(c[18609] | 0, c[h >> 2] | 0) | 0;
   c[g >> 2] = e;
   if (e | 0) {
    if ((d[(c[g >> 2] | 0) + 12 >> 0] | 0) & 8 | 0) Ae(c[(c[g >> 2] | 0) + 8 >> 2] | 0);
   } else c[g >> 2] = Kc(c[18609] | 0, c[h >> 2] | 0) | 0;
   c[(c[g >> 2] | 0) + 16 >> 2] = 0;
   a[(c[g >> 2] | 0) + 12 >> 0] = 56;
   h = bb((Zd(c[f >> 2] | 0) | 0) + 1 | 0) | 0;
   h = $d(h, c[f >> 2] | 0) | 0;
   c[(c[g >> 2] | 0) + 8 >> 2] = h;
   i = j;
   return;
  }

  function Od(a, b, d, e, f) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0;
   j = i;
   i = i + 256 | 0;
   h = j;
   do if ((d | 0) > (e | 0) & (f & 73728 | 0) == 0) {
    f = d - e | 0;
    Ee(h | 0, b | 0, (f >>> 0 > 256 ? 256 : f) | 0) | 0;
    b = c[a >> 2] | 0;
    g = (b & 32 | 0) == 0;
    if (f >>> 0 > 255) {
     d = d - e | 0;
     do {
      if (g) {
       Jd(h, 256, a) | 0;
       b = c[a >> 2] | 0;
      }
      f = f + -256 | 0;
      g = (b & 32 | 0) == 0;
     } while (f >>> 0 > 255);
     if (g) f = d & 255; else break;
    } else if (!g) break;
    Jd(h, f, a) | 0;
   } while (0);
   i = j;
   return;
  }

  function oe(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   m = i;
   i = i + 16 | 0;
   k = m;
   l = e & 255;
   a[k >> 0] = l;
   f = b + 16 | 0;
   g = c[f >> 2] | 0;
   if (!g) if (!(Td(b) | 0)) {
    g = c[f >> 2] | 0;
    h = 4;
   } else f = -1; else h = 4;
   do if ((h | 0) == 4) {
    j = b + 20 | 0;
    h = c[j >> 2] | 0;
    if (h >>> 0 < g >>> 0) {
     f = e & 255;
     if ((f | 0) != (a[b + 75 >> 0] | 0)) {
      c[j >> 2] = h + 1;
      a[h >> 0] = l;
      break;
     }
    }
    if ((wa[c[b + 36 >> 2] & 7](b, k, 1) | 0) == 1) f = d[k >> 0] | 0; else f = -1;
   } while (0);
   i = m;
   return f | 0;
  }

  function dd(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0, k = 0, l = 0;
   k = i;
   i = i + 96 | 0;
   j = k;
   e = k + 80 | 0;
   l = k + 12 | 0;
   f = k + 8 | 0;
   g = k + 4 | 0;
   h = k + 16 | 0;
   a[e >> 0] = b;
   c[l >> 2] = d;
   Mc();
   if (Yc(c[l >> 2] | 0, f) | 0) {
    cd(0, 0);
    i = k;
    return;
   }
   if (ed() | 0) {
    l = c[f >> 2] | 0;
    c[g >> 2] = l - (fd() | 0) - 1;
    if ((c[g >> 2] | 0) > 127 | (c[g >> 2] | 0) < -128) {
     c[j >> 2] = c[g >> 2];
     Dd(h, 63460, j) | 0;
     Ya(15, 0, h) | 0;
    }
   } else c[g >> 2] = 0;
   cd(a[e >> 0] | 0, c[g >> 2] & 255);
   i = k;
   return;
  }

  function ne(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   if ((d | 0) == 1) b = b - (c[a + 8 >> 2] | 0) + (c[a + 4 >> 2] | 0) | 0;
   e = a + 20 | 0;
   f = a + 28 | 0;
   if ((c[e >> 2] | 0) >>> 0 > (c[f >> 2] | 0) >>> 0) {
    wa[c[a + 36 >> 2] & 7](a, 0, 0) | 0;
    if (!(c[e >> 2] | 0)) b = -1; else g = 5;
   } else g = 5;
   if ((g | 0) == 5) {
    c[a + 16 >> 2] = 0;
    c[f >> 2] = 0;
    c[e >> 2] = 0;
    if ((wa[c[a + 40 >> 2] & 7](a, b, d) | 0) < 0) b = -1; else {
     c[a + 8 >> 2] = 0;
     c[a + 4 >> 2] = 0;
     c[a >> 2] = c[a >> 2] & -17;
     b = 0;
    }
   }
   return b | 0;
  }

  function Sb(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   e = g + 8 | 0;
   f = g;
   c[e >> 2] = b;
   c[g + 4 >> 2] = d;
   if (a[(c[18608] | 0) + 9 >> 0] | 0) if (a[(c[18608] | 0) + 10 >> 0] | 0) {
    Mc();
    c[f >> 2] = Zb(c[e >> 2] | 0, 0) | 0;
    if (a[(c[f >> 2] | 0) + 12 >> 0] | 0) {
     c[16552] = (c[16552] | 0) + 1;
     c[16550] = c[16550] | 2048;
     Qb(0);
     a[(c[18608] | 0) + 10 >> 0] = 0;
     c[16553] = c[16553] | 1;
    } else Qb((c[(c[f >> 2] | 0) + 16 >> 2] | 0) != 0 ^ 1 ^ 1);
    Nc(c[f >> 2] | 0);
    i = g;
    return;
   }
   Qb(0);
   i = g;
   return;
  }

  function Yd(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0, j = 0;
   h = i;
   i = i + 256 | 0;
   e = h;
   a : do if ((d | 0) >= 2) {
    g = b + (d << 2) | 0;
    c[g >> 2] = e;
    if (a | 0) while (1) {
     f = a >>> 0 > 256 ? 256 : a;
     Ne(e | 0, c[b >> 2] | 0, f | 0) | 0;
     e = 0;
     do {
      j = b + (e << 2) | 0;
      e = e + 1 | 0;
      Ne(c[j >> 2] | 0, c[b + (e << 2) >> 2] | 0, f | 0) | 0;
      c[j >> 2] = (c[j >> 2] | 0) + f;
     } while ((e | 0) != (d | 0));
     a = a - f | 0;
     if (!a) break a;
     e = c[g >> 2] | 0;
    }
   } while (0);
   i = h;
   return;
  }

  function _c(b, d, e, f) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0, l = 0, m = 0;
   g = i;
   i = i + 32 | 0;
   k = g + 12 | 0;
   m = g + 8 | 0;
   l = g + 4 | 0;
   j = g + 16 | 0;
   h = g;
   c[k >> 2] = b;
   c[m >> 2] = d;
   c[l >> 2] = e;
   a[j >> 0] = f & 1;
   f = Zd(c[m >> 2] | 0) | 0;
   c[h >> 2] = bb(f + (Zd(c[l >> 2] | 0) | 0) + 64 | 0) | 0;
   $d(c[h >> 2] | 0, c[m >> 2] | 0) | 0;
   ye(c[h >> 2] | 0, 63382) | 0;
   ye(c[h >> 2] | 0, c[l >> 2] | 0) | 0;
   Ya(c[k >> 2] | 0, a[j >> 0] & 1, c[h >> 2] | 0) | 0;
   Ae(c[h >> 2] | 0);
   i = g;
   return;
  }

  function he(a) {
   a = a | 0;
   var b = 0, d = 0;
   do if (!a) {
    if (!(c[14216] | 0)) b = 0; else b = he(c[14216] | 0) | 0;
    ha(76404);
    a = c[19100] | 0;
    if (a) do {
     if ((c[a + 76 >> 2] | 0) > -1) d = Id(a) | 0; else d = 0;
     if ((c[a + 20 >> 2] | 0) >>> 0 > (c[a + 28 >> 2] | 0) >>> 0) b = ie(a) | 0 | b;
     if (d | 0) md(a);
     a = c[a + 56 >> 2] | 0;
    } while ((a | 0) != 0);
    pa(76404);
   } else {
    if ((c[a + 76 >> 2] | 0) <= -1) {
     b = ie(a) | 0;
     break;
    }
    d = (Id(a) | 0) == 0;
    b = ie(a) | 0;
    if (!d) md(a);
   } while (0);
   return b | 0;
  }

  function Xc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   if (Yc(c[d >> 2] | 0, f) | 0) {
    Zc(0);
    i = g;
    return;
   }
   switch (c[f >> 2] | 0) {
   case 1:
    {
     Zc(c[(c[e >> 2] | 0) + 20 >> 2] & 255);
     i = g;
     return;
    }
   case 4:
    {
     Zc((c[(c[e >> 2] | 0) + 20 >> 2] | 0) + 2 & 255);
     i = g;
     return;
    }
   default:
    {
     _c(29, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
     Zc(0);
     i = g;
     return;
    }
   }
  }

  function ie(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0, g = 0, h = 0;
   g = a + 20 | 0;
   h = a + 28 | 0;
   if ((c[g >> 2] | 0) >>> 0 > (c[h >> 2] | 0) >>> 0) {
    wa[c[a + 36 >> 2] & 7](a, 0, 0) | 0;
    if (!(c[g >> 2] | 0)) b = -1; else d = 3;
   } else d = 3;
   if ((d | 0) == 3) {
    b = a + 4 | 0;
    d = c[b >> 2] | 0;
    e = a + 8 | 0;
    f = c[e >> 2] | 0;
    if (d >>> 0 < f >>> 0) wa[c[a + 40 >> 2] & 7](a, d - f | 0, 1) | 0;
    c[a + 16 >> 2] = 0;
    c[h >> 2] = 0;
    c[g >> 2] = 0;
    c[e >> 2] = 0;
    c[b >> 2] = 0;
    b = 0;
   }
   return b | 0;
  }

  function _d(b, c) {
   b = b | 0;
   c = c | 0;
   var e = 0, f = 0, g = 0;
   e = a[b >> 0] | 0;
   a : do if (!(e << 24 >> 24)) e = 0; else {
    g = e & 255;
    while (1) {
     f = a[c >> 0] | 0;
     if (!(f << 24 >> 24)) break a;
     if (e << 24 >> 24 != f << 24 >> 24) {
      g = qd(g) | 0;
      if ((g | 0) != (qd(f & 255) | 0)) break a;
     }
     b = b + 1 | 0;
     c = c + 1 | 0;
     e = a[b >> 0] | 0;
     if (!(e << 24 >> 24)) {
      e = 0;
      break;
     } else g = e & 255;
    }
   } while (0);
   g = qd(e & 255) | 0;
   return g - (qd(d[c >> 0] | 0) | 0) | 0;
  }

  function Ne(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0;
   if ((e | 0) >= 4096) return na(b | 0, d | 0, e | 0) | 0;
   f = b | 0;
   if ((b & 3) == (d & 3)) {
    while (b & 3) {
     if (!e) return f | 0;
     a[b >> 0] = a[d >> 0] | 0;
     b = b + 1 | 0;
     d = d + 1 | 0;
     e = e - 1 | 0;
    }
    while ((e | 0) >= 4) {
     c[b >> 2] = c[d >> 2];
     b = b + 4 | 0;
     d = d + 4 | 0;
     e = e - 4 | 0;
    }
   }
   while ((e | 0) > 0) {
    a[b >> 0] = a[d >> 0] | 0;
    b = b + 1 | 0;
    d = d + 1 | 0;
    e = e - 1 | 0;
   }
   return f | 0;
  }

  function Ld(b, c, d) {
   b = b | 0;
   c = c | 0;
   d = d | 0;
   var e = 0;
   if (c >>> 0 > 0 | (c | 0) == 0 & b >>> 0 > 4294967295) {
    while (1) {
     e = Pe(b | 0, c | 0, 10, 0) | 0;
     d = d + -1 | 0;
     a[d >> 0] = e | 48;
     e = b;
     b = Je(b | 0, c | 0, 10, 0) | 0;
     if (!(c >>> 0 > 9 | (c | 0) == 9 & e >>> 0 > 4294967295)) break; else c = D;
    }
    c = b;
   } else c = b;
   if (c) while (1) {
    d = d + -1 | 0;
    a[d >> 0] = (c >>> 0) % 10 | 0 | 48;
    if (c >>> 0 < 10) break; else c = (c >>> 0) / 10 | 0;
   }
   return d | 0;
  }

  function Zd(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0;
   f = b;
   a : do if (!(f & 3)) e = 4; else {
    d = f;
    while (1) {
     if (!(a[b >> 0] | 0)) {
      b = d;
      break a;
     }
     b = b + 1 | 0;
     d = b;
     if (!(d & 3)) {
      e = 4;
      break;
     }
    }
   } while (0);
   if ((e | 0) == 4) {
    while (1) {
     d = c[b >> 2] | 0;
     if (!((d & -2139062144 ^ -2139062144) & d + -16843009)) b = b + 4 | 0; else break;
    }
    if ((d & 255) << 24 >> 24) do b = b + 1 | 0; while ((a[b >> 0] | 0) != 0);
   }
   return b - f | 0;
  }

  function Wa(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0;
   e = i;
   i = i + 16 | 0;
   b = e + 4 | 0;
   d = e;
   c[b >> 2] = a;
   c[b >> 2] = (c[b >> 2] | 0) + 4 - 1 & -4;
   if ((c[b >> 2] | 0) > (c[16542] | 0)) {
    a = ze(16384) | 0;
    c[16543] = a;
    if (!a) Na(58280);
    Ee(c[16543] | 0, 0, 16384) | 0;
    c[16542] = 16384;
    if ((c[b >> 2] | 0) > (c[16542] | 0)) Na(58297);
   }
   c[d >> 2] = c[16543];
   c[16543] = (c[16543] | 0) + (c[b >> 2] | 0);
   c[16542] = (c[16542] | 0) - (c[b >> 2] | 0);
   i = e;
   return c[d >> 2] | 0;
  }

  function Rd(a, b) {
   a = +a;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   h[l >> 3] = a;
   d = c[l >> 2] | 0;
   e = c[l + 4 >> 2] | 0;
   f = Fe(d | 0, e | 0, 52) | 0;
   switch (f & 2047) {
   case 0:
    {
     if (a != 0.0) {
      a = +Rd(a * 18446744073709551616.0, b);
      d = (c[b >> 2] | 0) + -64 | 0;
     } else d = 0;
     c[b >> 2] = d;
     break;
    }
   case 2047:
    break;
   default:
    {
     c[b >> 2] = (f & 2047) + -1022;
     c[l >> 2] = d;
     c[l + 4 >> 2] = e & -2146435073 | 1071644672;
     a = +h[l >> 3];
    }
   }
   return +a;
  }

  function cc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   f = k + 12 | 0;
   g = k + 8 | 0;
   h = k + 4 | 0;
   j = k;
   c[f >> 2] = a;
   c[g >> 2] = b;
   c[h >> 2] = d;
   c[j >> 2] = e;
   if (c[h >> 2] | c[j >> 2] | 0) {
    Gc(0, c[h >> 2] | c[j >> 2], 0);
    i = k;
    return;
   }
   if (!(c[g >> 2] | 0)) {
    Ya(8, 1, 0) | 0;
    Gc(0, 0, 0);
    i = k;
    return;
   } else {
    Gc((c[f >> 2] | 0) / (c[g >> 2] | 0) | 0, 0, 0);
    i = k;
    return;
   }
  }

  function ec(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   f = k + 12 | 0;
   j = k + 8 | 0;
   g = k + 4 | 0;
   h = k;
   c[f >> 2] = a;
   c[j >> 2] = b;
   c[g >> 2] = d;
   c[h >> 2] = e;
   if (c[g >> 2] | c[h >> 2] | 0) {
    Gc(0, c[g >> 2] | c[h >> 2], 0);
    i = k;
    return;
   }
   a = c[f >> 2] | 0;
   if (!(c[j >> 2] | 0)) {
    Gc(a, 0, 0);
    i = k;
    return;
   } else {
    Gc((a | 0) % (c[j >> 2] | 0) | 0, 0, 0);
    i = k;
    return;
   }
  }

  function Cd(b, c, e) {
   b = b | 0;
   c = c | 0;
   e = e | 0;
   var f = 0, g = 0;
   if (!e) f = 0; else {
    f = a[b >> 0] | 0;
    a : do if (!(f << 24 >> 24)) f = 0; else while (1) {
     e = e + -1 | 0;
     g = a[c >> 0] | 0;
     if (!(f << 24 >> 24 == g << 24 >> 24 & ((e | 0) != 0 & g << 24 >> 24 != 0))) break a;
     b = b + 1 | 0;
     c = c + 1 | 0;
     f = a[b >> 0] | 0;
     if (!(f << 24 >> 24)) {
      f = 0;
      break;
     }
    } while (0);
    f = (f & 255) - (d[c >> 0] | 0) | 0;
   }
   return f | 0;
  }

  function yd(b) {
   b = b | 0;
   var d = 0, e = 0;
   d = b + 74 | 0;
   e = a[d >> 0] | 0;
   a[d >> 0] = e + 255 | e;
   d = b + 20 | 0;
   e = b + 44 | 0;
   if ((c[d >> 2] | 0) >>> 0 > (c[e >> 2] | 0) >>> 0) wa[c[b + 36 >> 2] & 7](b, 0, 0) | 0;
   c[b + 16 >> 2] = 0;
   c[b + 28 >> 2] = 0;
   c[d >> 2] = 0;
   d = c[b >> 2] | 0;
   if (!(d & 20)) {
    d = c[e >> 2] | 0;
    c[b + 8 >> 2] = d;
    c[b + 4 >> 2] = d;
    d = 0;
   } else if (!(d & 4)) d = -1; else {
    c[b >> 2] = d | 32;
    d = -1;
   }
   return d | 0;
  }

  function de(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0;
   g = i;
   i = i + 32 | 0;
   f = g + 16 | 0;
   e = g;
   if (!(Nd(66155, a[d >> 0] | 0, 4) | 0)) {
    c[(kd() | 0) >> 2] = 22;
    b = 0;
   } else {
    h = ee(d) | 0 | 32768;
    c[e >> 2] = b;
    c[e + 4 >> 2] = h;
    c[e + 8 >> 2] = 438;
    e = jd(ma(5, e | 0) | 0) | 0;
    if ((e | 0) < 0) b = 0; else {
     b = fe(e, d) | 0;
     if (!b) {
      c[f >> 2] = e;
      ka(6, f | 0) | 0;
      b = 0;
     }
    }
   }
   i = g;
   return b | 0;
  }

  function kb() {
   var a = 0, b = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   a = f + 8 | 0;
   b = f + 4 | 0;
   e = f;
   c[b >> 2] = 0;
   c[e >> 2] = 0;
   while (1) {
    if ((c[e >> 2] | 0) >= 1024) break;
    c[a >> 2] = c[66224 + (c[e >> 2] << 2) >> 2];
    while (1) {
     if (!(c[a >> 2] | 0)) break;
     if ((d[(c[a >> 2] | 0) + 12 >> 0] | 0) & 1 | 0) c[b >> 2] = (c[b >> 2] | 0) + 1;
     c[a >> 2] = c[c[a >> 2] >> 2];
    }
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   i = f;
   return c[b >> 2] | 0;
  }

  function Qb(b) {
   b = b | 0;
   var e = 0, f = 0, g = 0;
   f = i;
   i = i + 16 | 0;
   g = f + 4 | 0;
   e = f;
   a[g >> 0] = b & 1;
   c[e >> 2] = ab(12) | 0;
   c[c[e >> 2] >> 2] = c[18608];
   c[(c[e >> 2] | 0) + 4 >> 2] = c[18604];
   a[(c[e >> 2] | 0) + 8 >> 0] = 0;
   a[(c[e >> 2] | 0) + 9 >> 0] = a[g >> 0] & 1;
   if (d[(c[18608] | 0) + 10 >> 0] | 0 | 0) b = (d[(c[18608] | 0) + 9 >> 0] | 0 | 0) != 0; else b = 0;
   a[(c[e >> 2] | 0) + 10 >> 0] = b & 1;
   c[18608] = c[e >> 2];
   i = f;
   return;
  }

  function Ee(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, i = 0;
   f = b + e | 0;
   if ((e | 0) >= 20) {
    d = d & 255;
    h = b & 3;
    i = d | d << 8 | d << 16 | d << 24;
    g = f & ~3;
    if (h) {
     h = b + 4 - h | 0;
     while ((b | 0) < (h | 0)) {
      a[b >> 0] = d;
      b = b + 1 | 0;
     }
    }
    while ((b | 0) < (g | 0)) {
     c[b >> 2] = i;
     b = b + 4 | 0;
    }
   }
   while ((b | 0) < (f | 0)) {
    a[b >> 0] = d;
    b = b + 1 | 0;
   }
   return b - e | 0;
  }

  function Md(b) {
   b = b | 0;
   var c = 0, e = 0;
   e = 0;
   while (1) {
    if ((d[64263 + e >> 0] | 0) == (b | 0)) {
     b = 2;
     break;
    }
    c = e + 1 | 0;
    if ((c | 0) == 87) {
     c = 64351;
     e = 87;
     b = 5;
     break;
    } else e = c;
   }
   if ((b | 0) == 2) if (!e) c = 64351; else {
    c = 64351;
    b = 5;
   }
   if ((b | 0) == 5) while (1) {
    do {
     b = c;
     c = c + 1 | 0;
    } while ((a[b >> 0] | 0) != 0);
    e = e + -1 | 0;
    if (!e) break; else b = 5;
   }
   return c | 0;
  }

  function sd(a, b, d, e, f) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   f = f | 0;
   var g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 112 | 0;
   h = k;
   c[h >> 2] = 0;
   j = h + 4 | 0;
   c[j >> 2] = a;
   c[h + 44 >> 2] = a;
   g = h + 8 | 0;
   c[g >> 2] = (a | 0) < 0 ? -1 : a + 2147483647 | 0;
   c[h + 76 >> 2] = -1;
   td(h, 0);
   d = ud(h, d, 1, e, f) | 0;
   if (b | 0) c[b >> 2] = a + ((c[j >> 2] | 0) + (c[h + 108 >> 2] | 0) - (c[g >> 2] | 0));
   i = k;
   return d | 0;
  }

  function xe(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0;
   e = c[14187] | 0;
   if ((c[e + 76 >> 2] | 0) > -1) f = Id(e) | 0; else f = 0;
   do if ((re(b, e) | 0) < 0) b = 1; else {
    if ((a[e + 75 >> 0] | 0) != 10) {
     b = e + 20 | 0;
     d = c[b >> 2] | 0;
     if (d >>> 0 < (c[e + 16 >> 2] | 0) >>> 0) {
      c[b >> 2] = d + 1;
      a[d >> 0] = 10;
      b = 0;
      break;
     }
    }
    b = (oe(e, 10) | 0) < 0;
   } while (0);
   if (f | 0) md(e);
   return b << 31 >> 31 | 0;
  }

  function xc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   j = i;
   i = i + 16 | 0;
   k = j + 12 | 0;
   f = j + 8 | 0;
   g = j + 4 | 0;
   h = j;
   c[k >> 2] = a;
   c[f >> 2] = b;
   c[g >> 2] = d;
   c[h >> 2] = e;
   if (!((c[g >> 2] | 0) == 0 & (c[k >> 2] | 0) != 0)) if (!((c[h >> 2] | 0) == 0 & (c[f >> 2] | 0) != 0)) {
    Gc(0, c[g >> 2] | c[h >> 2], 0);
    i = j;
    return;
   }
   Gc(1, 0, 0);
   i = j;
   return;
  }

  function Ub(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   f = g;
   c[g + 8 >> 2] = b;
   c[g + 4 >> 2] = e;
   c[f >> 2] = c[18608];
   if (d[(c[f >> 2] | 0) + 8 >> 0] & 4 | 0) {
    i = g;
    return;
   }
   if (a[(c[f >> 2] | 0) + 10 >> 0] | 0) Mc();
   if ((c[(c[f >> 2] | 0) + 4 >> 2] | 0) != (c[18604] | 0)) {
    xe(61773) | 0;
    i = g;
    return;
   } else {
    c[18608] = c[c[f >> 2] >> 2];
    Ae(c[f >> 2] | 0);
    i = g;
    return;
   }
  }

  function uc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   j = i;
   i = i + 16 | 0;
   k = j + 12 | 0;
   f = j + 8 | 0;
   g = j + 4 | 0;
   h = j;
   c[k >> 2] = a;
   c[f >> 2] = b;
   c[g >> 2] = d;
   c[h >> 2] = e;
   if ((c[g >> 2] | 0) != 0 | (c[k >> 2] | 0) != 0) if ((c[h >> 2] | 0) != 0 | (c[f >> 2] | 0) != 0) {
    Gc(1, c[g >> 2] | c[h >> 2], 0);
    i = j;
    return;
   }
   Gc(0, 0, 0);
   i = j;
   return;
  }

  function ge(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0;
   e = (c[a >> 2] & 1 | 0) != 0;
   if (!e) {
    ha(76404);
    d = c[a + 52 >> 2] | 0;
    b = a + 56 | 0;
    if (d | 0) c[d + 56 >> 2] = c[b >> 2];
    b = c[b >> 2] | 0;
    if (b | 0) c[b + 52 >> 2] = d;
    if ((c[19100] | 0) == (a | 0)) c[19100] = b;
    pa(76404);
   }
   b = he(a) | 0;
   b = za[c[a + 12 >> 2] & 1](a) | 0 | b;
   d = c[a + 92 >> 2] | 0;
   if (d | 0) Ae(d);
   if (!e) Ae(a);
   return b | 0;
  }

  function fc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   f = k + 12 | 0;
   g = k + 8 | 0;
   h = k + 4 | 0;
   j = k;
   c[f >> 2] = a;
   c[g >> 2] = b;
   c[h >> 2] = d;
   c[j >> 2] = e;
   if (c[h >> 2] | 0) {
    Gc(0, c[h >> 2] | 0, 0);
    i = k;
    return;
   } else {
    Gc(c[f >> 2] | 0 ? c[g >> 2] | 0 : 0, c[f >> 2] | 0 ? c[j >> 2] | 0 : 0, 0);
    i = k;
    return;
   }
  }

  function Lc() {
   var a = 0, b = 0, d = 0;
   b = i;
   i = i + 16 | 0;
   a = b;
   if (c[19075] | 0) {
    c[a >> 2] = c[19075];
    c[19075] = c[c[19075] >> 2];
    d = c[a >> 2] | 0;
    c[d >> 2] = 0;
    c[d + 4 >> 2] = 0;
    c[d + 8 >> 2] = 0;
    c[d + 12 >> 2] = 0;
    c[d + 16 >> 2] = 0;
    c[d + 20 >> 2] = 0;
    a = c[a >> 2] | 0;
    i = b;
    return a | 0;
   } else {
    c[a >> 2] = Wa(24) | 0;
    d = c[a >> 2] | 0;
    i = b;
    return d | 0;
   }
   return 0;
  }

  function Dc(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   e = f;
   c[e >> 2] = b;
   Gc(0, 8, c[e >> 2] | 0);
   while (1) {
    if (a[c[e >> 2] >> 0] | 0) d = (a[c[e >> 2] >> 0] | 0) != 34; else d = 0;
    b = c[e >> 2] | 0;
    if (!d) break;
    c[e >> 2] = b + 1;
   }
   if ((a[b >> 0] | 0) != 34) {
    e = c[e >> 2] | 0;
    i = f;
    return e | 0;
   }
   c[e >> 2] = (c[e >> 2] | 0) + 1;
   e = c[e >> 2] | 0;
   i = f;
   return e | 0;
  }

  function Ma() {
   var e = 0, f = 0, g = 0, h = 0;
   g = i;
   i = i + 16 | 0;
   e = g;
   f = g + 4 | 0;
   b[f >> 1] = 0;
   while (1) {
    if ((b[f >> 1] | 0) >= 1024) break;
    c[e >> 2] = c[66224 + (b[f >> 1] << 2) >> 2];
    while (1) {
     if (!(c[e >> 2] | 0)) break;
     h = (c[e >> 2] | 0) + 12 | 0;
     a[h >> 0] = d[h >> 0] & -5;
     c[e >> 2] = c[c[e >> 2] >> 2];
    }
    b[f >> 1] = (b[f >> 1] | 0) + 1 << 16 >> 16;
   }
   i = g;
   return;
  }

  function Fc(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   e = g + 4 | 0;
   f = g;
   c[e >> 2] = b;
   c[f >> 2] = 0;
   while (1) {
    if ((a[c[e >> 2] >> 0] | 0) >= 48) d = (a[c[e >> 2] >> 0] | 0) <= 57; else d = 0;
    b = c[f >> 2] | 0;
    if (!d) break;
    c[f >> 2] = (b * 10 | 0) + ((a[c[e >> 2] >> 0] | 0) - 48);
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   Gc(b, 0, 0);
   i = g;
   return c[e >> 2] | 0;
  }

  function Ua(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 4 | 0;
   e = g + 8 | 0;
   f = g;
   c[d >> 2] = b;
   c[f >> 2] = c[d >> 2];
   while (1) {
    b = a[c[f >> 2] >> 0] | 0;
    a[e >> 0] = b;
    if (!(b << 24 >> 24)) break;
    if ((a[e >> 0] | 0) >= 65) if ((a[e >> 0] | 0) <= 90) a[c[f >> 2] >> 0] = a[e >> 0] | 32;
    c[f >> 2] = (c[f >> 2] | 0) + 1;
   }
   i = g;
   return c[d >> 2] | 0;
  }

  function Ec(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   e = g + 4 | 0;
   f = g;
   c[e >> 2] = b;
   c[f >> 2] = 0;
   while (1) {
    if ((a[c[e >> 2] >> 0] | 0) >= 48) d = (a[c[e >> 2] >> 0] | 0) <= 55; else d = 0;
    b = c[f >> 2] | 0;
    if (!d) break;
    c[f >> 2] = (b << 3) + ((a[c[e >> 2] >> 0] | 0) - 48);
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   Gc(b, 0, 0);
   i = g;
   return c[e >> 2] | 0;
  }

  function oc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   f = k + 12 | 0;
   g = k + 8 | 0;
   h = k + 4 | 0;
   j = k;
   c[f >> 2] = a;
   c[g >> 2] = b;
   c[h >> 2] = d;
   c[j >> 2] = e;
   if (c[h >> 2] | c[j >> 2] | 0) {
    Gc(0, c[h >> 2] | c[j >> 2], 0);
    i = k;
    return;
   } else {
    Gc(c[f >> 2] << c[g >> 2], 0, 0);
    i = k;
    return;
   }
  }

  function kc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   k = i;
   i = i + 16 | 0;
   f = k + 12 | 0;
   g = k + 8 | 0;
   h = k + 4 | 0;
   j = k;
   c[f >> 2] = a;
   c[g >> 2] = b;
   c[h >> 2] = d;
   c[j >> 2] = e;
   if (c[h >> 2] | c[j >> 2] | 0) {
    Gc(0, c[h >> 2] | c[j >> 2], 0);
    i = k;
    return;
   } else {
    Gc(c[f >> 2] >> c[g >> 2], 0, 0);
    i = k;
    return;
   }
  }

  function dc(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   e = g + 4 | 0;
   f = g;
   c[e >> 2] = b;
   c[f >> 2] = 0;
   while (1) {
    if ((a[c[e >> 2] >> 0] | 0) == 48) d = 1; else d = (a[c[e >> 2] >> 0] | 0) == 49;
    b = c[f >> 2] | 0;
    if (!d) break;
    c[f >> 2] = b << 1 | (a[c[e >> 2] >> 0] | 0) - 48;
    c[e >> 2] = (c[e >> 2] | 0) + 1;
   }
   Gc(b, 0, 0);
   i = g;
   return c[e >> 2] | 0;
  }

  function eb(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   f = g;
   d = g + 8 | 0;
   e = g + 4 | 0;
   a[d >> 0] = b & 1;
   if (!(c[18873] | 0)) {
    i = g;
    return;
   }
   c[e >> 2] = de(c[18873] | 0, 63458) | 0;
   if (c[e >> 2] | 0) {
    fb(c[e >> 2] | 0, a[d >> 0] & 1);
    ge(c[e >> 2] | 0) | 0;
    i = g;
    return;
   } else {
    c[f >> 2] = c[18873];
    ve(58470, f) | 0;
    i = g;
    return;
   }
  }

  function Sc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   Yc(c[d >> 2] | 0, f) | 0;
   if ((c[f >> 2] | 0) >>> 0 > 65535) _c(33, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
   bd(c[(c[e >> 2] | 0) + 20 >> 2] & 255, (c[f >> 2] | 0) >>> 8 & 255, c[f >> 2] & 255);
   i = g;
   return;
  }

  function Jc(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0, h = 0;
   h = i;
   i = i + 16 | 0;
   e = h + 8 | 0;
   f = h + 4 | 0;
   g = h;
   c[e >> 2] = b;
   c[f >> 2] = d;
   c[g >> 2] = 0;
   while (1) {
    d = c[f >> 2] | 0;
    c[f >> 2] = d + -1;
    b = c[g >> 2] | 0;
    if (!d) break;
    d = c[e >> 2] | 0;
    c[e >> 2] = d + 1;
    c[g >> 2] = b << 2 ^ a[d >> 0];
   }
   i = h;
   return b & 1023 | 0;
  }

  function Bd(b, c, d) {
   b = b | 0;
   c = c | 0;
   d = d | 0;
   var e = 0, f = 0;
   a : do if (!d) b = 0; else {
    while (1) {
     e = a[b >> 0] | 0;
     f = a[c >> 0] | 0;
     if (e << 24 >> 24 != f << 24 >> 24) break;
     d = d + -1 | 0;
     if (!d) {
      b = 0;
      break a;
     } else {
      b = b + 1 | 0;
      c = c + 1 | 0;
     }
    }
    b = (e & 255) - (f & 255) | 0;
   } while (0);
   return b | 0;
  }

  function Nc(a) {
   a = a | 0;
   var b = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   b = f + 4 | 0;
   e = f;
   c[b >> 2] = a;
   while (1) {
    if (!(c[b >> 2] | 0)) break;
    c[e >> 2] = c[c[b >> 2] >> 2];
    c[c[b >> 2] >> 2] = c[19075];
    if ((d[(c[b >> 2] | 0) + 12 >> 0] | 0) & 8 | 0) Ae(c[(c[b >> 2] | 0) + 8 >> 2] | 0);
    c[19075] = c[b >> 2];
    c[b >> 2] = c[e >> 2];
   }
   i = f;
   return;
  }

  function Ad(b, c) {
   b = b | 0;
   c = c | 0;
   var d = 0, e = 0;
   d = a[b >> 0] | 0;
   e = a[c >> 0] | 0;
   if (d << 24 >> 24 == 0 ? 1 : d << 24 >> 24 != e << 24 >> 24) b = e; else {
    do {
     b = b + 1 | 0;
     c = c + 1 | 0;
     d = a[b >> 0] | 0;
     e = a[c >> 0] | 0;
    } while (!(d << 24 >> 24 == 0 ? 1 : d << 24 >> 24 != e << 24 >> 24));
    b = e;
   }
   return (d & 255) - (b & 255) | 0;
  }

  function Tc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   Yc(c[d >> 2] | 0, f) | 0;
   if ((c[f >> 2] | 0) >>> 0 > 15) _c(30, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
   Zc((c[(c[e >> 2] | 0) + 20 >> 2] | c[f >> 2] & 15) & 255);
   i = g;
   return;
  }

  function Oc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   Yc(c[d >> 2] | 0, f) | 0;
   if ((c[f >> 2] | 0) >>> 0 > 255) _c(19, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
   cd(c[(c[e >> 2] | 0) + 20 >> 2] & 255, c[f >> 2] & 255);
   i = g;
   return;
  }

  function ee(b) {
   b = b | 0;
   var c = 0, d = 0, e = 0;
   d = (be(b, 43) | 0) == 0;
   c = a[b >> 0] | 0;
   d = d ? c << 24 >> 24 != 114 & 1 : 2;
   e = (be(b, 120) | 0) == 0;
   d = e ? d : d | 128;
   b = (be(b, 101) | 0) == 0;
   b = b ? d : d | 524288;
   b = c << 24 >> 24 == 114 ? b : b | 64;
   b = c << 24 >> 24 == 119 ? b | 512 : b;
   return (c << 24 >> 24 == 97 ? b | 1024 : b) | 0;
  }

  function Vc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   Yc(c[d >> 2] | 0, f) | 0;
   if ((c[f >> 2] | 0) >>> 0 > 7) _c(31, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
   Zc((c[(c[e >> 2] | 0) + 20 >> 2] | c[f >> 2] & 7) & 255);
   i = g;
   return;
  }

  function Td(b) {
   b = b | 0;
   var d = 0, e = 0;
   d = b + 74 | 0;
   e = a[d >> 0] | 0;
   a[d >> 0] = e + 255 | e;
   d = c[b >> 2] | 0;
   if (!(d & 8)) {
    c[b + 8 >> 2] = 0;
    c[b + 4 >> 2] = 0;
    e = c[b + 44 >> 2] | 0;
    c[b + 28 >> 2] = e;
    c[b + 20 >> 2] = e;
    c[b + 16 >> 2] = e + (c[b + 48 >> 2] | 0);
    b = 0;
   } else {
    c[b >> 2] = d | 32;
    b = -1;
   }
   return b | 0;
  }

  function bb(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0, f = 0;
   e = i;
   i = i + 16 | 0;
   b = e + 8 | 0;
   f = e + 4 | 0;
   d = e;
   c[f >> 2] = a;
   c[d >> 2] = ze(c[f >> 2] | 0) | 0;
   if (c[d >> 2] | 0) {
    c[b >> 2] = c[d >> 2];
    f = c[b >> 2] | 0;
    i = e;
    return f | 0;
   } else {
    Na(58280);
    c[b >> 2] = 0;
    f = c[b >> 2] | 0;
    i = e;
    return f | 0;
   }
   return 0;
  }

  function La() {
   var b = 0, e = 0;
   e = i;
   i = i + 16 | 0;
   b = e;
   c[b >> 2] = c[18606];
   while (1) {
    if (!(c[b >> 2] | 0)) break;
    a[(c[b >> 2] | 0) + 8 >> 0] = (d[(c[b >> 2] | 0) + 8 >> 0] | 0) & 16 | 1;
    a[(c[b >> 2] | 0) + 29 >> 0] = 1;
    a[(c[b >> 2] | 0) + 28 >> 0] = 1;
    a[(c[b >> 2] | 0) + 9 >> 0] = 1;
    c[b >> 2] = c[c[b >> 2] >> 2];
   }
   i = e;
   return;
  }

  function id(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   f = i;
   i = i + 32 | 0;
   g = f;
   e = f + 20 | 0;
   c[g >> 2] = c[a + 60 >> 2];
   c[g + 4 >> 2] = 0;
   c[g + 8 >> 2] = b;
   c[g + 12 >> 2] = e;
   c[g + 16 >> 2] = d;
   if ((jd(la(140, g | 0) | 0) | 0) < 0) {
    c[e >> 2] = -1;
    a = -1;
   } else a = c[e >> 2] | 0;
   i = f;
   return a | 0;
  }

  function hb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0;
   d = i;
   i = i + 16 | 0;
   h = d + 12 | 0;
   g = d + 8 | 0;
   f = d + 4 | 0;
   e = d;
   c[h >> 2] = a;
   c[g >> 2] = b;
   c[f >> 2] = c[c[h >> 2] >> 2];
   c[e >> 2] = c[c[g >> 2] >> 2];
   b = _d(c[(c[f >> 2] | 0) + 4 >> 2] | 0, c[(c[e >> 2] | 0) + 4 >> 2] | 0) | 0;
   i = d;
   return b | 0;
  }

  function gb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0, h = 0;
   f = i;
   i = i + 16 | 0;
   h = f + 12 | 0;
   g = f + 8 | 0;
   e = f + 4 | 0;
   d = f;
   c[h >> 2] = a;
   c[g >> 2] = b;
   c[e >> 2] = c[c[h >> 2] >> 2];
   c[d >> 2] = c[c[g >> 2] >> 2];
   i = f;
   return (c[(c[e >> 2] | 0) + 16 >> 2] | 0) - (c[(c[d >> 2] | 0) + 16 >> 2] | 0) | 0;
  }

  function bc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   e = S(c[k >> 2] | 0, c[j >> 2] | 0) | 0;
   Gc(e, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function Uc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   d = g + 8 | 0;
   e = g + 4 | 0;
   f = g;
   c[d >> 2] = a;
   c[e >> 2] = b;
   Mc();
   Yc(c[d >> 2] | 0, f) | 0;
   if ((c[f >> 2] | 0) >>> 0 > 15) _c(30, c[(c[e >> 2] | 0) + 8 >> 2] | 0, c[d >> 2] | 0, 0);
   Zc((112 | c[f >> 2] & 15) & 255);
   i = g;
   return;
  }

  function Tb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0;
   f = i;
   i = i + 16 | 0;
   c[f + 4 >> 2] = b;
   c[f >> 2] = e;
   if (!(d[(c[18608] | 0) + 10 >> 0] | 0)) {
    i = f;
    return;
   }
   if (d[(c[18608] | 0) + 8 >> 0] & 4 | 0) {
    i = f;
    return;
   }
   Mc();
   a[(c[18608] | 0) + 9 >> 0] = ((a[(c[18608] | 0) + 9 >> 0] | 0) != 0 ^ 1) & 1;
   i = f;
   return;
  }

  function tc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) != (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function rc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) == (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function pc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) <= (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function lc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) >= (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function qc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) < (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function mc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) > (c[j >> 2] | 0) & 1, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function ic(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) - (c[j >> 2] | 0) | 0, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function gc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc((c[k >> 2] | 0) + (c[j >> 2] | 0) | 0, c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function pd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0;
   g = i;
   i = i + 80 | 0;
   f = g;
   c[b + 36 >> 2] = 4;
   if (!(c[b >> 2] & 64)) {
    c[f >> 2] = c[b + 60 >> 2];
    c[f + 4 >> 2] = 21505;
    c[f + 8 >> 2] = g + 12;
    if (oa(54, f | 0) | 0) a[b + 75 >> 0] = -1;
   }
   f = hd(b, d, e) | 0;
   i = g;
   return f | 0;
  }

  function yc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc(c[k >> 2] | c[j >> 2], c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function wc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc(c[k >> 2] ^ c[j >> 2], c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function vc(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0, k = 0;
   f = i;
   i = i + 16 | 0;
   k = f + 12 | 0;
   j = f + 8 | 0;
   h = f + 4 | 0;
   g = f;
   c[k >> 2] = a;
   c[j >> 2] = b;
   c[h >> 2] = d;
   c[g >> 2] = e;
   Gc(c[k >> 2] & c[j >> 2], c[h >> 2] | c[g >> 2], 0);
   i = f;
   return;
  }

  function bd(b, d, e) {
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0, h = 0, j = 0;
   f = i;
   i = i + 16 | 0;
   j = f + 2 | 0;
   h = f + 1 | 0;
   g = f;
   a[j >> 0] = b;
   a[h >> 0] = d;
   a[g >> 0] = e;
   c[16544] = 3;
   a[1091574] = a[j >> 0] | 0;
   a[1091575] = a[h >> 0] | 0;
   a[1091576] = a[g >> 0] | 0;
   nb();
   i = f;
   return;
  }

  function Cc(b) {
   b = b | 0;
   var d = 0, e = 0;
   e = i;
   i = i + 16 | 0;
   d = e;
   c[d >> 2] = b;
   if (a[c[d >> 2] >> 0] | 0) {
    Gc(a[c[d >> 2] >> 0] | 0, 0, 0);
    c[d >> 2] = (c[d >> 2] | 0) + 1;
    d = c[d >> 2] | 0;
    i = e;
    return d | 0;
   } else {
    Gc(32, 0, 0);
    d = c[d >> 2] | 0;
    i = e;
    return d | 0;
   }
   return 0;
  }

  function Sa(b) {
   b = b | 0;
   var d = 0, e = 0, f = 0, g = 0;
   f = i;
   i = i + 16 | 0;
   d = f + 4 | 0;
   e = f;
   c[d >> 2] = b;
   c[e >> 2] = 0;
   while (1) {
    b = c[e >> 2] | 0;
    if (!(a[c[d >> 2] >> 0] | 0)) break;
    g = c[d >> 2] | 0;
    c[d >> 2] = g + 1;
    c[e >> 2] = b << 2 ^ a[g >> 0];
   }
   i = f;
   return b & 1023 | 0;
  }

  function Oe(b, c, d) {
   b = b | 0;
   c = c | 0;
   d = d | 0;
   var e = 0;
   if ((c | 0) < (b | 0) & (b | 0) < (c + d | 0)) {
    e = b;
    c = c + d | 0;
    b = b + d | 0;
    while ((d | 0) > 0) {
     b = b - 1 | 0;
     c = c - 1 | 0;
     d = d - 1 | 0;
     a[b >> 0] = a[c >> 0] | 0;
    }
    b = e;
   } else Ne(b, c, d) | 0;
   return b | 0;
  }

  function qe(a) {
   a = a | 0;
   var b = 0;
   if (!(c[a >> 2] & 128)) b = 1; else b = (c[a + 20 >> 2] | 0) >>> 0 > (c[a + 28 >> 2] | 0) >>> 0 ? 2 : 1;
   b = wa[c[a + 40 >> 2] & 7](a, 0, b) | 0;
   if ((b | 0) >= 0) b = b - (c[a + 8 >> 2] | 0) + (c[a + 4 >> 2] | 0) + (c[a + 20 >> 2] | 0) - (c[a + 28 >> 2] | 0) | 0;
   return b | 0;
  }

  function Ke(a, b) {
   a = a | 0;
   b = b | 0;
   var c = 0, d = 0, e = 0, f = 0;
   f = a & 65535;
   e = b & 65535;
   c = S(e, f) | 0;
   d = a >>> 16;
   a = (c >>> 16) + (S(e, d) | 0) | 0;
   e = b >>> 16;
   b = S(e, f) | 0;
   return (D = (a >>> 16) + (S(e, d) | 0) + (((a & 65535) + b | 0) >>> 16) | 0, a + b << 16 | c & 65535 | 0) | 0;
  }

  function qb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   e = i;
   i = i + 16 | 0;
   f = e + 8 | 0;
   d = e;
   c[f >> 2] = a;
   c[e + 4 >> 2] = b;
   Mc();
   c[d >> 2] = rb(c[f >> 2] | 0) | 0;
   $a(c[d >> 2] | 0);
   if ((c[d >> 2] | 0) == (c[f >> 2] | 0)) {
    i = e;
    return;
   }
   Ae(c[d >> 2] | 0);
   i = e;
   return;
  }

  function Me(a) {
   a = a | 0;
   var b = 0, d = 0;
   d = a + 15 & -16 | 0;
   b = c[k >> 2] | 0;
   a = b + d | 0;
   if ((d | 0) > 0 & (a | 0) < (b | 0) | (a | 0) < 0) {
    _() | 0;
    ja(12);
    return -1;
   }
   c[k >> 2] = a;
   if ((a | 0) > (Z() | 0)) if (!(Y() | 0)) {
    ja(12);
    c[k >> 2] = b;
    return -1;
   }
   return b | 0;
  }

  function ab(a) {
   a = a | 0;
   var b = 0, d = 0, e = 0;
   e = i;
   i = i + 16 | 0;
   b = e + 4 | 0;
   d = e;
   c[b >> 2] = a;
   c[d >> 2] = bb(c[b >> 2] | 0) | 0;
   if (!(c[d >> 2] | 0)) {
    d = c[d >> 2] | 0;
    i = e;
    return d | 0;
   }
   Ee(c[d >> 2] | 0, 0, c[b >> 2] | 0) | 0;
   d = c[d >> 2] | 0;
   i = e;
   return d | 0;
  }

  function se(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0;
   f = S(d, b) | 0;
   if ((c[e + 76 >> 2] | 0) > -1) {
    g = (Id(e) | 0) == 0;
    a = Jd(a, f, e) | 0;
    if (!g) md(e);
   } else a = Jd(a, f, e) | 0;
   if ((a | 0) != (f | 0)) d = (a >>> 0) / (b >>> 0) | 0;
   return d | 0;
  }

  function Pa(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   d = f + 8 | 0;
   e = f;
   c[d >> 2] = a;
   c[f + 4 >> 2] = b;
   b = c[c[d >> 2] >> 2] | 0;
   c[e >> 2] = b;
   if (!b) {
    i = f;
    return;
   }
   c[c[d >> 2] >> 2] = c[c[e >> 2] >> 2];
   Ae(c[e >> 2] | 0);
   i = f;
   return;
  }

  function Ac(a) {
   a = a | 0;
   var b = 0, d = 0;
   d = i;
   i = i + 16 | 0;
   b = d;
   c[b >> 2] = a;
   if ((c[b >> 2] | 0) >= 97 & (c[b >> 2] | 0) <= 122) a = 1; else if ((c[b >> 2] | 0) >= 65 & (c[b >> 2] | 0) <= 90) a = 1; else a = (c[b >> 2] | 0) >= 48 ? (c[b >> 2] | 0) <= 57 : 0;
   i = d;
   return a & 1 | 0;
  }

  function He(b) {
   b = b | 0;
   var c = 0;
   c = a[n + (b & 255) >> 0] | 0;
   if ((c | 0) < 8) return c | 0;
   c = a[n + (b >> 8 & 255) >> 0] | 0;
   if ((c | 0) < 8) return c + 8 | 0;
   c = a[n + (b >> 16 & 255) >> 0] | 0;
   if ((c | 0) < 8) return c + 16 | 0;
   return (a[n + (b >>> 24) >> 0] | 0) + 24 | 0;
  }

  function Rb(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0;
   e = i;
   i = i + 16 | 0;
   g = e + 8 | 0;
   f = e;
   c[g >> 2] = a;
   c[e + 4 >> 2] = b;
   Mc();
   c[f >> 2] = Zb(c[g >> 2] | 0, 0) | 0;
   Qb((d[(c[f >> 2] | 0) + 12 >> 0] | 0 | 0) != 0);
   Nc(c[f >> 2] | 0);
   i = e;
   return;
  }

  function Pb(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0;
   e = i;
   i = i + 16 | 0;
   g = e + 8 | 0;
   f = e;
   c[g >> 2] = a;
   c[e + 4 >> 2] = b;
   Mc();
   c[f >> 2] = Zb(c[g >> 2] | 0, 0) | 0;
   Qb((d[(c[f >> 2] | 0) + 12 >> 0] | 0 | 0) == 0);
   Nc(c[f >> 2] | 0);
   i = e;
   return;
  }

  function xd(a) {
   a = a | 0;
   var b = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   b = f;
   if (!(c[a + 8 >> 2] | 0)) if (!(yd(a) | 0)) e = 3; else a = -1; else e = 3;
   if ((e | 0) == 3) if ((wa[c[a + 32 >> 2] & 7](a, b, 1) | 0) == 1) a = d[b >> 0] | 0; else a = -1;
   i = f;
   return a | 0;
  }

  function Pc(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0, f = 0, g = 0, h = 0;
   e = i;
   i = i + 16 | 0;
   h = e + 4 | 0;
   g = e;
   f = e + 8 | 0;
   c[h >> 2] = a;
   c[g >> 2] = b;
   Mc();
   ad(c[h >> 2] | 0, f) | 0;
   Zc((c[(c[g >> 2] | 0) + 20 >> 2] | (d[f >> 0] | 0)) & 255);
   i = e;
   return;
  }

  function td(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   c[a + 104 >> 2] = b;
   d = c[a + 8 >> 2] | 0;
   e = c[a + 4 >> 2] | 0;
   f = d - e | 0;
   c[a + 108 >> 2] = f;
   if ((b | 0) != 0 & (f | 0) > (b | 0)) c[a + 100 >> 2] = e + b; else c[a + 100 >> 2] = d;
   return;
  }

  function ed() {
   var b = 0, e = 0, f = 0;
   f = i;
   i = i + 16 | 0;
   e = f;
   b = c[18607] | 0;
   if ((d[(c[18607] | 0) + 8 >> 0] | 0) & 32 | 0) b = a[b + 9 >> 0] | 0; else b = a[b + 8 >> 0] | 0;
   a[e >> 0] = b;
   i = f;
   return (((d[e >> 0] | 0) & 3 | 0) == 0 ? 1 : 0) | 0;
  }

  function Mb(a, b) {
   a = a | 0;
   b = b | 0;
   var e = 0;
   e = i;
   i = i + 16 | 0;
   c[e + 4 >> 2] = a;
   c[e >> 2] = b;
   while (1) {
    if (!((d[(c[18604] | 0) + 16 >> 0] | 0) & 1)) break;
    Nb(0, 0);
   }
   ke(c[(c[18604] | 0) + 8 >> 2] | 0, 0, 2) | 0;
   i = e;
   return;
  }

  function Ud(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = a + 20 | 0;
   f = c[e >> 2] | 0;
   a = (c[a + 16 >> 2] | 0) - f | 0;
   a = a >>> 0 > d >>> 0 ? d : a;
   Ne(f | 0, b | 0, a | 0) | 0;
   c[e >> 2] = (c[e >> 2] | 0) + a;
   return d | 0;
  }

  function cd(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   e = i;
   i = i + 16 | 0;
   g = e + 1 | 0;
   f = e;
   a[g >> 0] = b;
   a[f >> 0] = d;
   c[16544] = 2;
   a[1091574] = a[g >> 0] | 0;
   a[1091575] = a[f >> 0] | 0;
   nb();
   i = e;
   return;
  }

  function Yb() {
   if (!((c[16552] | 0) == 0 & (c[111] | 0) == 2)) return;
   ke(c[18875] | 0, c[16547] | 0, 0) | 0;
   we(c[16548] & 255, c[18875] | 0) | 0;
   we(c[16548] >> 8 & 255, c[18875] | 0) | 0;
   ke(c[18875] | 0, 0, 2) | 0;
   return;
  }

  function Qc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   e = d + 4 | 0;
   f = d;
   c[e >> 2] = a;
   c[f >> 2] = b;
   dd(c[(c[f >> 2] | 0) + 20 >> 2] & 255, c[e >> 2] | 0);
   i = d;
   return;
  }

  function sc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   f = d + 4 | 0;
   e = d;
   c[f >> 2] = a;
   c[e >> 2] = b;
   Gc(((c[f >> 2] | 0) != 0 ^ 1) & 1, c[e >> 2] | 0, 0);
   i = d;
   return;
  }

  function hc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   f = d + 4 | 0;
   e = d;
   c[f >> 2] = a;
   c[e >> 2] = b;
   Gc(0 - (c[f >> 2] | 0) | 0, c[e >> 2] | 0, 0);
   i = d;
   return;
  }

  function Pe(a, b, d, e) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   e = e | 0;
   var f = 0, g = 0;
   g = i;
   i = i + 16 | 0;
   f = g | 0;
   Ie(a, b, d, e, f) | 0;
   i = g;
   return (D = c[f + 4 >> 2] | 0, c[f >> 2] | 0) | 0;
  }

  function Hc(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0, g = 0;
   e = i;
   i = i + 16 | 0;
   g = e + 4 | 0;
   f = e;
   c[g >> 2] = b;
   c[f >> 2] = d;
   c[19080] = c[g >> 2];
   a[76316] = c[f >> 2];
   i = e;
   return;
  }

  function ob(b, d) {
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = i;
   i = i + 16 | 0;
   f = e + 4 | 0;
   c[f >> 2] = b;
   c[e >> 2] = d;
   a[1091839] = (a[(c[f >> 2] | 0) + 1 >> 0] | 0) == 110 & 1;
   i = e;
   return;
  }

  function me(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0;
   if ((c[a + 76 >> 2] | 0) > -1) {
    e = (Id(a) | 0) == 0;
    b = ne(a, b, d) | 0;
    if (!e) md(a);
   } else b = ne(a, b, d) | 0;
   return b | 0;
  }

  function jc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   f = d + 4 | 0;
   e = d;
   c[f >> 2] = a;
   c[e >> 2] = b;
   Gc(c[f >> 2] >> 8 & 255, c[e >> 2] | 0, 0);
   i = d;
   return;
  }

  function nc(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   f = d + 4 | 0;
   e = d;
   c[f >> 2] = a;
   c[e >> 2] = b;
   Gc(c[f >> 2] & 255, c[e >> 2] | 0, 0);
   i = d;
   return;
  }

  function Le(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = a;
   f = c;
   c = Ke(e, f) | 0;
   a = D;
   return (D = (S(b, f) | 0) + (S(d, e) | 0) + a | a & 0, c | 0 | 0) | 0;
  }

  function Eb(b, e) {
   b = b | 0;
   e = e | 0;
   var f = 0;
   f = i;
   i = i + 16 | 0;
   c[f + 4 >> 2] = b;
   c[f >> 2] = e;
   Mc();
   e = (c[18607] | 0) + 8 | 0;
   a[e >> 0] = (d[e >> 0] | 0) & -33;
   i = f;
   return;
  }

  function fd() {
   var a = 0;
   a = c[18607] | 0;
   if ((d[(c[18607] | 0) + 8 >> 0] | 0) & 32 | 0) {
    a = c[a + 16 >> 2] | 0;
    return a | 0;
   } else {
    a = c[a + 12 >> 2] | 0;
    return a | 0;
   }
   return 0;
  }

  function _b(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0, f = 0;
   d = i;
   i = i + 16 | 0;
   f = d + 4 | 0;
   e = d;
   c[f >> 2] = a;
   c[e >> 2] = b;
   Gc(~c[f >> 2], c[e >> 2] | 0, 0);
   i = d;
   return;
  }

  function Gb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0;
   d = i;
   i = i + 16 | 0;
   c[d + 4 >> 2] = a;
   c[d >> 2] = b;
   c[18868] = (c[18868] | 0) + 1;
   c[18867] = c[18868];
   Mc();
   i = d;
   return;
  }

  function Ge(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   if ((c | 0) < 32) {
    D = b << c | (a & (1 << c) - 1 << 32 - c) >>> 32 - c;
    return a << c;
   }
   D = a << c - 32;
   return 0;
  }

  function Fe(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   if ((c | 0) < 32) {
    D = b >>> c;
    return a >>> c | (b & (1 << c) - 1) << 32 - c;
   }
   D = 0;
   return b >>> c - 32 | 0;
  }

  function Be() {}
  function Ce(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   d = b - d - (c >>> 0 > a >>> 0 | 0) >>> 0;
   return (D = d, a - c >>> 0 | 0) | 0;
  }

  function le(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = i;
   i = i + 16 | 0;
   f = e;
   c[f >> 2] = d;
   d = Gd(a, b, f) | 0;
   i = e;
   return d | 0;
  }

  function Dd(a, b, d) {
   a = a | 0;
   b = b | 0;
   d = d | 0;
   var e = 0, f = 0;
   e = i;
   i = i + 16 | 0;
   f = e;
   c[f >> 2] = d;
   d = Ed(a, b, f) | 0;
   i = e;
   return d | 0;
  }

  function ve(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0, e = 0;
   d = i;
   i = i + 16 | 0;
   e = d;
   c[e >> 2] = b;
   b = Gd(c[14187] | 0, a, e) | 0;
   i = d;
   return b | 0;
  }

  function Zc(b) {
   b = b | 0;
   var d = 0, e = 0;
   d = i;
   i = i + 16 | 0;
   e = d;
   a[e >> 0] = b;
   c[16544] = 1;
   a[1091574] = a[e >> 0] | 0;
   nb();
   i = d;
   return;
  }

  function gd(a) {
   a = a | 0;
   var b = 0, d = 0;
   b = i;
   i = i + 16 | 0;
   d = b;
   c[d >> 2] = c[a + 60 >> 2];
   a = jd(ka(6, d | 0) | 0) | 0;
   i = b;
   return a | 0;
  }

  function De(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   c = a + c >>> 0;
   return (D = b + d + (c >>> 0 < a >>> 0 | 0) >>> 0, c | 0) | 0;
  }

  function pe(a) {
   a = a | 0;
   var b = 0;
   if ((c[a + 76 >> 2] | 0) > -1) {
    b = (Id(a) | 0) == 0;
    a = qe(a) | 0;
   } else a = qe(a) | 0;
   return a | 0;
  }

  function yb(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0;
   d = i;
   i = i + 16 | 0;
   c[d + 4 >> 2] = a;
   c[d >> 2] = b;
   Mc();
   Ya(16, 1, 0) | 0;
   qa(1);
  }

  function Ob(a, b) {
   a = a | 0;
   b = b | 0;
   var d = 0;
   d = i;
   i = i + 16 | 0;
   c[d + 4 >> 2] = a;
   c[d >> 2] = b;
   Nb(0, 0);
   i = d;
   return;
  }

  function Ja(a) {
   a = a | 0;
   var b = 0, d = 0;
   b = i;
   i = i + 16 | 0;
   d = b;
   c[d >> 2] = a;
   ye(76922, c[d >> 2] | 0) | 0;
   i = b;
   return;
  }

  function We(a, b, c, d, e) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   e = e | 0;
   Ba[a & 31](b | 0, c | 0, d | 0, e | 0);
  }

  function be(b, c) {
   b = b | 0;
   c = c | 0;
   b = ce(b, c) | 0;
   return ((a[b >> 0] | 0) == (c & 255) << 24 >> 24 ? b : 0) | 0;
  }

  function Re(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   return wa[a & 7](b | 0, c | 0, d | 0) | 0;
  }

  function jd(a) {
   a = a | 0;
   if (a >>> 0 > 4294963200) {
    c[(kd() | 0) >> 2] = 0 - a;
    a = -1;
   }
   return a | 0;
  }

  function kd() {
   var a = 0;
   if (!(c[19094] | 0)) a = 76420; else a = c[(Qe() | 0) + 64 >> 2] | 0;
   return a | 0;
  }

  function Na(a) {
   a = a | 0;
   var b = 0;
   b = i;
   i = i + 16 | 0;
   c[b >> 2] = a;
   xe(c[b >> 2] | 0) | 0;
   qa(1);
  }

  function zd(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   c = sd(a, b, c, -2147483648, 0) | 0;
   return c | 0;
  }

  function Je(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   return Ie(a, b, c, d, 0) | 0;
  }

  function Pd(a, b) {
   a = a | 0;
   b = b | 0;
   if (!a) a = 0; else a = Sd(a, b, 0) | 0;
   return a | 0;
  }
  function Ca(a) {
   a = a | 0;
   var b = 0;
   b = i;
   i = i + a | 0;
   i = i + 15 & -16;
   return b | 0;
  }

  function Ve(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   return Aa[a & 3](b | 0, c | 0) | 0;
  }

  function Ed(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   return Fd(a, 2147483647, b, c) | 0;
  }

  function qd(a) {
   a = a | 0;
   var b = 0;
   b = (rd(a) | 0) == 0;
   return (b ? a : a | 32) | 0;
  }

  function ye(a, b) {
   a = a | 0;
   b = b | 0;
   $d(a + (Zd(a) | 0) | 0, b) | 0;
   return a | 0;
  }

  function re(a, b) {
   a = a | 0;
   b = b | 0;
   return (se(a, Zd(a) | 0, 1, b) | 0) + -1 | 0;
  }

  function wd(a) {
   a = a | 0;
   return ((a | 0) == 32 | (a + -9 | 0) >>> 0 < 5) & 1 | 0;
  }

  function Te(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   ya[a & 63](b | 0, c | 0);
  }

  function ke(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   return me(a, b, c) | 0;
  }

  function af(a, b, c, d) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   d = d | 0;
   W(5);
  }

  function Xe(a, b, c) {
   a = a | 0;
   b = b | 0;
   c = c | 0;
   W(0);
   return 0;
  }

  function Ga(a, b) {
   a = a | 0;
   b = b | 0;
   if (!o) {
    o = a;
    p = b;
   }
  }

  function Ue(a, b) {
   a = a | 0;
   b = b | 0;
   return za[a & 1](b | 0) | 0;
  }

  function $d(a, b) {
   a = a | 0;
   b = b | 0;
   ae(a, b) | 0;
   return a | 0;
  }

  function od(a) {
   a = a | 0;
   if (!(c[a + 68 >> 2] | 0)) md(a);
   return;
  }

  function ld(a) {
   a = a | 0;
   if (!(c[a + 68 >> 2] | 0)) md(a);
   return;
  }

  function rd(a) {
   a = a | 0;
   return (a + -65 | 0) >>> 0 < 26 | 0;
  }

  function Se(a, b) {
   a = a | 0;
   b = b | 0;
   xa[a & 3](b | 0);
  }

  function Qd(a, b) {
   a = +a;
   b = b | 0;
   return +(+Rd(a, b));
  }

  function $e(a, b) {
   a = a | 0;
   b = b | 0;
   W(4);
   return 0;
  }

  function Fa(a, b) {
   a = a | 0;
   b = b | 0;
   i = a;
   j = b;
  }

  function Ze(a, b) {
   a = a | 0;
   b = b | 0;
   W(2);
  }

  function ue(a) {
   a = a | 0;
   return pe(a) | 0;
  }

  function _e(a) {
   a = a | 0;
   W(3);
   return 0;
  }

  function Id(a) {
   a = a | 0;
   return 0;
  }

  function md(a) {
   a = a | 0;
   return;
  }

  function Ha(a) {
   a = a | 0;
   D = a;
  }

  function Ea(a) {
   a = a | 0;
   i = a;
  }

  function Ye(a) {
   a = a | 0;
   W(1);
  }

  function Ia() {
   return D | 0;
  }

  function Da() {
   return i | 0;
  }

  function Qe() {
   return 0;
  }

  // EMSCRIPTEN_END_FUNCS

   var wa = [ Xe, pd, id, Ud, hd, nd, Xe, Xe ];
   var xa = [ Ye, ld, od, Ye ];
   var ya = [ Ze, pb, qb, vb, wb, yb, zb, Ab, Mb, ob, Cb, Db, Eb, Fb, Gb, Hb, Ib, Kb, Ta, Nb, Ob, Pb, Rb, Sb, Tb, Ub, Vb, Wb, Jb, lb, sb, Xb, mb, Oc, Pc, Qc, Rc, Sc, Tc, Uc, Vc, Wc, Xc, Lb, _b, hc, jc, nc, sc, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze, Ze ];
   var za = [ _e, gd ];
   var Aa = [ $e, gb, hb, $e ];
   var Ba = [ af, bc, cc, ec, fc, gc, ic, kc, lc, mc, oc, pc, qc, rc, tc, uc, vc, wc, xc, yc, af, af, af, af, af, af, af, af, af, af, af, af ];
   return {
    ___muldsi3: Ke,
    _sbrk: Me,
    _i64Subtract: Ce,
    _free: Ae,
    _main: cb,
    _i64Add: De,
    _memmove: Oe,
    _pthread_self: Qe,
    _memset: Ee,
    _llvm_cttz_i32: He,
    _malloc: ze,
    _memcpy: Ne,
    ___muldi3: Le,
    _bitshift64Shl: Ge,
    _bitshift64Lshr: Fe,
    _fflush: he,
    ___udivdi3: Je,
    ___uremdi3: Pe,
    ___errno_location: kd,
    ___udivmoddi4: Ie,
    runPostSets: Be,
    stackAlloc: Ca,
    stackSave: Da,
    stackRestore: Ea,
    establishStackSpace: Fa,
    setThrew: Ga,
    setTempRet0: Ha,
    getTempRet0: Ia,
    dynCall_iiii: Re,
    dynCall_vi: Se,
    dynCall_vii: Te,
    dynCall_ii: Ue,
    dynCall_iii: Ve,
    dynCall_viiii: We
   };
  })


  // EMSCRIPTEN_END_ASM
  (Module.asmGlobalArg, Module.asmLibraryArg, buffer);
  var ___muldsi3 = Module["___muldsi3"] = asm["___muldsi3"];
  var _malloc = Module["_malloc"] = asm["_malloc"];
  var _i64Subtract = Module["_i64Subtract"] = asm["_i64Subtract"];
  var _free = Module["_free"] = asm["_free"];
  var _main = Module["_main"] = asm["_main"];
  var _i64Add = Module["_i64Add"] = asm["_i64Add"];
  var _memmove = Module["_memmove"] = asm["_memmove"];
  var ___udivmoddi4 = Module["___udivmoddi4"] = asm["___udivmoddi4"];
  var _pthread_self = Module["_pthread_self"] = asm["_pthread_self"];
  var _memset = Module["_memset"] = asm["_memset"];
  var _llvm_cttz_i32 = Module["_llvm_cttz_i32"] = asm["_llvm_cttz_i32"];
  var _sbrk = Module["_sbrk"] = asm["_sbrk"];
  var _memcpy = Module["_memcpy"] = asm["_memcpy"];
  var runPostSets = Module["runPostSets"] = asm["runPostSets"];
  var ___muldi3 = Module["___muldi3"] = asm["___muldi3"];
  var _bitshift64Lshr = Module["_bitshift64Lshr"] = asm["_bitshift64Lshr"];
  var _fflush = Module["_fflush"] = asm["_fflush"];
  var ___udivdi3 = Module["___udivdi3"] = asm["___udivdi3"];
  var ___uremdi3 = Module["___uremdi3"] = asm["___uremdi3"];
  var ___errno_location = Module["___errno_location"] = asm["___errno_location"];
  var _bitshift64Shl = Module["_bitshift64Shl"] = asm["_bitshift64Shl"];
  var dynCall_iiii = Module["dynCall_iiii"] = asm["dynCall_iiii"];
  var dynCall_vi = Module["dynCall_vi"] = asm["dynCall_vi"];
  var dynCall_vii = Module["dynCall_vii"] = asm["dynCall_vii"];
  var dynCall_ii = Module["dynCall_ii"] = asm["dynCall_ii"];
  var dynCall_iii = Module["dynCall_iii"] = asm["dynCall_iii"];
  var dynCall_viiii = Module["dynCall_viiii"] = asm["dynCall_viiii"];
  Runtime.stackAlloc = asm["stackAlloc"];
  Runtime.stackSave = asm["stackSave"];
  Runtime.stackRestore = asm["stackRestore"];
  Runtime.establishStackSpace = asm["establishStackSpace"];
  Runtime.setTempRet0 = asm["setTempRet0"];
  Runtime.getTempRet0 = asm["getTempRet0"];
  function ExitStatus(status) {
   this.name = "ExitStatus";
   this.message = "Program terminated with exit(" + status + ")";
   this.status = status;
  }
  ExitStatus.prototype = new Error;
  ExitStatus.prototype.constructor = ExitStatus;
  var initialStackTop;
  dependenciesFulfilled = function runCaller() {
   if (!Module["calledRun"]) run();
   if (!Module["calledRun"]) dependenciesFulfilled = runCaller;
  };
  Module["callMain"] = Module.callMain = function callMain(args) {
   args = args || [];
   ensureInitRuntime();
   var argc = args.length + 1;
   function pad() {
    for (var i = 0; i < 4 - 1; i++) {
     argv.push(0);
    }
   }
   var argv = [ allocate(intArrayFromString(Module["thisProgram"]), "i8", ALLOC_NORMAL) ];
   pad();
   for (var i = 0; i < argc - 1; i = i + 1) {
    argv.push(allocate(intArrayFromString(args[i]), "i8", ALLOC_NORMAL));
    pad();
   }
   argv.push(0);
   argv = allocate(argv, "i32", ALLOC_NORMAL);
   try {
    var ret = Module["_main"](argc, argv, 0);
    exit(ret, true);
   } catch (e) {
    if (e instanceof ExitStatus) {
     return;
    } else if (e == "SimulateInfiniteLoop") {
     Module["noExitRuntime"] = true;
     return;
    } else {
     if (e && typeof e === "object" && e.stack) Module.printErr("exception thrown: " + [ e, e.stack ]);
     throw e;
    }
   } finally {
   }
  };
  function run(args) {
   args = args || Module["arguments"];
   if (runDependencies > 0) {
    return;
   }
   preRun();
   if (runDependencies > 0) return;
   if (Module["calledRun"]) return;
   function doRun() {
    if (Module["calledRun"]) return;
    Module["calledRun"] = true;
    if (ABORT) return;
    ensureInitRuntime();
    preMain();
    if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
    if (Module["_main"] && shouldRunNow) Module["callMain"](args);
    postRun();
   }
   if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout((function() {
     setTimeout((function() {
      Module["setStatus"]("");
     }), 1);
     doRun();
    }), 1);
   } else {
    doRun();
   }
  }
  Module["run"] = Module.run = run;
  function exit(status, implicit) {
   if (implicit && Module["noExitRuntime"]) {
    return;
   }
   if (Module["noExitRuntime"]) ; else {
    ABORT = true;
    EXITSTATUS = status;
    STACKTOP = initialStackTop;
    exitRuntime();
    if (Module["onExit"]) Module["onExit"](status);
   }
   if (ENVIRONMENT_IS_NODE) {
    process["exit"](status);
   } else if (ENVIRONMENT_IS_SHELL && typeof quit === "function") {
    quit(status);
   }
   throw new ExitStatus(status);
  }
  Module["exit"] = Module.exit = exit;
  var abortDecorators = [];
  function abort(what) {
   if (what !== undefined) {
    Module.print(what);
    Module.printErr(what);
    what = JSON.stringify(what);
   } else {
    what = "";
   }
   ABORT = true;
   EXITSTATUS = 1;
   var extra = "\nIf this abort() is unexpected, build with -s ASSERTIONS=1 which can give more information.";
   var output = "abort(" + what + ") at " + stackTrace() + extra;
   if (abortDecorators) {
    abortDecorators.forEach((function(decorator) {
     output = decorator(output, what);
    }));
   }
   throw output;
  }
  Module["abort"] = Module.abort = abort;
  if (Module["preInit"]) {
   if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
   while (Module["preInit"].length > 0) {
    Module["preInit"].pop()();
   }
  }
  var shouldRunNow = true;
  if (Module["noInitialRun"]) {
   shouldRunNow = false;
  }
  run();
  DASM["FS"] = FS;
  DASM["getStatus"] = (function() {
   return EXITSTATUS;
  });





    return DASM;
  };
  var exports = module.exports = { DASM: DASM };
  });
  var dasm_1 = dasm.DASM;

  var resolveIncludes_1 = createCommonjsModule(function (module, exports) {
  /**
   * Resolve all file includes in the source
   */
  Object.defineProperty(exports, "__esModule", { value: true });

  var INCLUDE_REGEXP = /^[^;\n]*[ \t]\binclude[ \t]+(?:"([^;"\n]+?)"|'([^;'\n]+?)'|([^ ;'"\n]+)\b)/gmi;
  var INCDIR_REGEXP = /^[^;\n]*[ \t]\bincdir[ \t]+(?:"([^;"\n]+?)"|'([^;'\n]+?)'|([^ ;'"\n]+)\b)/gmi;
  var INCBIN_REGEXP = /^[^;\n]*[ \t]\bincbin[ \t]+(?:"([^;"\n]+?)"|'([^;'\n]+?)'|([^ ;'"\n]+)\b)/gmi;
  function resolveIncludes(entrySource, getFile, baseDir, recursive) {
      if (baseDir === void 0) { baseDir = ""; }
      if (recursive === void 0) { recursive = true; }
      // All the base folders a file can have for included files
      var defaultDir = { line: -1, column: -1, value: "" };
      var includeDirs = [defaultDir].concat(searchInSource(entrySource, INCDIR_REGEXP)).map(function (includeDir) { return includeDir.value; });
      var textIncludes = searchInSource(entrySource, INCLUDE_REGEXP);
      var binaryIncludes = searchInSource(entrySource, INCBIN_REGEXP);
      var includes = [];
      includes = includes.concat(textIncludes.map(function (textInclude) {
          return createIncludeFromSearchResult(textInclude, false, baseDir, recursive, includeDirs, getFile);
      }));
      includes = includes.concat(binaryIncludes.map(function (binaryInclude) {
          return createIncludeFromSearchResult(binaryInclude, true, baseDir, recursive, includeDirs, getFile);
      }));
      return includes;
  }
  exports.default = resolveIncludes;
  /**
   * Based on a search result, create an include file
   */
  function createIncludeFromSearchResult(include, isBinary, baseDir, recursive, includeDirs, getFile) {
      var uri;
      var contents;
      for (var _i = 0, includeDirs_1 = includeDirs; _i < includeDirs_1.length; _i++) {
          var includeDir = includeDirs_1[_i];
          uri = path$1.posix.join(baseDir, includeDir, include.value);
          contents = uri && getFile ? getFile(uri, isBinary) : undefined;
          if (contents) {
              break;
          }
      }
      // Also parse the include file's own includes
      var childIncludes = [];
      if (recursive && uri && getFile && typeof (contents) === "string") {
          childIncludes = childIncludes.concat(resolveIncludes(contents, getFile, path$1.posix.dirname(uri), recursive));
      }
      return {
          line: include.line,
          column: include.column,
          entryRelativeUri: include.value,
          parentRelativeUri: uri ? uri : include.value,
          isBinary: isBinary,
          includes: childIncludes,
          contents: contents ? contents : undefined,
      };
  }
  /**
   * Search for a string in a source document and returns all results (line, column, and value)
   */
  function searchInSource(source, regexp) {
      var results = [];
      var match = regexp.exec(source);
      var _loop_1 = function () {
          var newResult = findMatchResult(match);
          if (newResult && !results.some(function (result) { return result.value === newResult.value; })) {
              results.push(newResult);
          }
          match = regexp.exec(source);
      };
      while (match) {
          _loop_1();
      }
      return results;
  }
  /**
   * Returns the first capturing group found in RegExp results
   */
  function findMatchResult(match) {
      if (match) {
          var value = match.find(function (possibleValue, index) { return typeof (index) === "number" && index > 0 && Boolean(possibleValue); });
          if (value) {
              // Also find where position of that specific match, searching within the result itself
              var fullMatch = match[0];
              var fullPos = match.index;
              // We are optimistically getting the match from the left;
              // this prevents false matches where the included file is called "include" too
              var valuePos = fullPos + fullMatch.lastIndexOf(value);
              // Convert the full position to a line and column
              var position = convertStringPosToLineColumn(match.input, valuePos);
              return {
                  line: position.line,
                  column: position.column,
                  value: value,
              };
          }
      }
      return undefined;
  }
  /**
   * Given a string and a single char position, return the line and column in that string that the char position is
   */
  function convertStringPosToLineColumn(source, position) {
      var LINE_REGEX = /(^)[\S\s]/gm;
      var line = 0;
      var column = 0;
      var lastPosition = 0;
      var match = LINE_REGEX.exec(source);
      while (match) {
          if (match.index > position) {
              column = position - lastPosition;
              break;
          }
          lastPosition = match.index;
          line++;
          match = LINE_REGEX.exec(source);
      }
      return {
          line: line,
          column: column,
      };
  }
  });

  unwrapExports(resolveIncludes_1);

  var lib = createCommonjsModule(function (module, exports) {
  Object.defineProperty(exports, "__esModule", { value: true });

  // Re-exports

  exports.resolveIncludes = resolveIncludes_1.default;
  // Configuration constants
  var FILENAME_IN = "file.a";
  var FILENAME_OUT = "file.out";
  var FILENAME_LIST = "file.lst";
  var FILENAME_SYMBOLS = "file.sym";
  // Variables used
  var Module;
  var didCompile = false;
  var log = [];
  // Methods and functions
  function logLine(s) {
      log.push(s);
  }
  function logErrorLine(s) {
      logLine("[ERROR] " + s);
  }
  function parseList(listFile) {
      var lines = [];
      var rawLinesOriginal = listFile.split("\n");
      var rawLines = rawLinesOriginal.map(function (line) { return convertTabsToSpaces(line); });
      var metaFileFind = /^------- FILE\s(.+?)(\s|$)/;
      var lineNumberFind = /^\s+([0-9]+)\s/;
      var unknownFind = /^\s*[0-9]+\s*[0-9A-Fa-fUuDd%]{4,5}\s\?{4}/;
      var addressFind = /^.{7} ([ 0-9A-Fa-fUuDd%]{5})/;
      var commentFind = /;(.*)$/;
      var byteCodeFind = /^[^;]{30} ([0-9a-fFuUdD% ]{8})/;
      var commandFind = /^([^;]*)/;
      var errorFind = /^[\w\.]* \(([0-9]+)\): error: (.*)/;
      var abortFind = /^Aborting assembly/;
      var breakingErrors = [];
      var currentLine = -1;
      var filename = undefined;
      rawLines.forEach(function (rawLine, index) {
          var rawLineOriginal = rawLinesOriginal[index];
          if (rawLine) {
              var metaFileMatches = rawLine.match(metaFileFind);
              if (metaFileMatches) {
                  // File start
                  filename = metaFileMatches[1];
                  if (filename === FILENAME_IN)
                      filename = undefined;
              }
              else {
                  // Default values
                  var errorMessage = undefined;
                  var address = -1;
                  var comment = undefined;
                  var bytes = undefined;
                  var command = undefined;
                  var skip = false;
                  var wasBreakingError = false;
                  // First, catch errors
                  var errorMatches = rawLine.match(errorFind);
                  if (errorMatches) {
                      errorMessage = errorMatches[2];
                      currentLine = parseInt(errorMatches[1], 10);
                      didCompile = false;
                      wasBreakingError = true;
                  }
                  else if (rawLine.match(abortFind)) {
                      didCompile = false;
                      skip = true;
                  }
                  else {
                      // If not, parse properly
                      // Current line
                      var lineNumberMatches = rawLine.match(lineNumberFind);
                      if (lineNumberMatches) {
                          currentLine = parseInt(lineNumberMatches[1], 10);
                      }
                      // Address
                      if (!rawLine.match(unknownFind)) {
                          // Known location
                          address = parseNumber(rawLine.match(addressFind)[1]);
                      }
                      // Comment
                      var commentMatches = rawLine.match(commentFind);
                      if (commentMatches) {
                          comment = commentMatches[1];
                      }
                      // Bytes
                      var byteMatches = rawLine.match(byteCodeFind);
                      if (byteMatches) {
                          bytes = parseBytes(byteMatches[1]);
                      }
                      // Commands
                      var commandMatches = substrWithTabSpaces(rawLineOriginal, 43).match(commandFind);
                      if (commandMatches) {
                          command = commandMatches[1];
                          if (!command.trim())
                              command = undefined;
                      }
                  }
                  if (!skip) {
                      var newLine = {
                          number: currentLine,
                          filename: filename,
                          address: address,
                          bytes: bytes,
                          raw: rawLine,
                          errorMessage: errorMessage,
                          comment: comment,
                          command: command,
                      };
                      if (wasBreakingError) {
                          breakingErrors.push(newLine);
                      }
                      else {
                          lines.push(newLine);
                      }
                  }
              }
          }
      });
      // Merge breaking errors with their lines
      lines = mergeLinesWithGlobalErrors(lines, breakingErrors);
      return lines;
  }
  function substrWithTabSpaces(text, start, length) {
      if (length === void 0) { length = -1; }
      // Returns a sub-string of the a string, but counting outside tabs as spaces in a similar fashion to convertTabsToSpaces()
      var pos = 0;
      var char = 0;
      while (pos < start) {
          if (text.charAt(char) === "\t") {
              pos += 8 - (pos % 8);
          }
          else {
              pos += 1;
          }
          char++;
      }
      return length < 0 ? text.substr(char) : text.substr(char, length);
  }
  function convertTabsToSpaces(line) {
      // The list file uses a strange format where it replaces 8 spaces with a tab whenever it needs to jump forward
      // The catch is that if there's one char + 7 spaces, it still uses a tab since it tabs relative to column positions
      var newLine = line;
      var pos = newLine.indexOf("\t");
      while (pos > -1) {
          var numSpaces = 8 - (pos % 8);
          newLine = newLine.substr(0, pos) + (("        ").substr(0, numSpaces)) + newLine.substr(pos + 1);
          pos = newLine.indexOf("\t");
      }
      return newLine;
  }
  function mergeLinesWithGlobalErrors(lines, errorLines) {
      var newLines = [];
      errorLines.forEach(function (error) {
          var errorLine = lines.find(function (line) { return line.number === error.number && line.filename === error.filename; });
          if (errorLine) {
              errorLine.errorMessage = error.errorMessage;
          }
          else {
              // No line, will create one
              newLines.push(error);
          }
      });
      // Merges errors with no proper lines
      return lines.concat(newLines);
  }
  function parseListFromOutput(listLines, outputLines) {
      // Adds messages from the output to the line-based list
      var newLines = [];
      var warningFind = /^Warning: (.*)/;
      var unresolvedSymbolStartFind = /^--- Unresolved Symbol List/;
      var unresolvedSymbolEndFind = /^--- [0-9]+ Unresolved Symbol/;
      var unresolvedSymbolFind = /^(.*?)\s/;
      var fileNotFoundErrorFind = /Unable to open '(.*)'$/;
      var isListingUnresolvedSymbols = false;
      outputLines.forEach(function (outputLine) {
          var errorMessage = undefined;
          var lineNumber = -1;
          var lineNumbers = [];
          var filename = undefined;
          var filenames = [];
          if (isListingUnresolvedSymbols) {
              var unresolvedSymbolEndMatches = outputLine.match(unresolvedSymbolEndFind);
              if (unresolvedSymbolEndMatches) {
                  // List of unresolved symbols - END
                  isListingUnresolvedSymbols = false;
              }
              else {
                  // Unresolved symbol
                  var unresolvedSymbolMatches = outputLine.match(unresolvedSymbolFind);
                  if (unresolvedSymbolMatches) {
                      var symbolName = unresolvedSymbolMatches[1];
                      // Injected error message
                      errorMessage = "Undefined Symbol '" + symbolName + "'";
                      var lineIndex = findStringInLines(listLines, symbolName);
                      while (lineIndex > -1) {
                          lineNumbers.push(listLines[lineIndex].number);
                          filenames.push(listLines[lineIndex].filename);
                          lineIndex = findStringInLines(listLines, symbolName, lineIndex + 1);
                      }
                  }
              }
          }
          else {
              var unresolvedSymbolStartMatches = outputLine.match(unresolvedSymbolStartFind);
              if (unresolvedSymbolStartMatches) {
                  // List of unresolved symbols - START
                  isListingUnresolvedSymbols = true;
              }
              else {
                  // Warnings
                  var warningMatches = outputLine.match(warningFind);
                  if (warningMatches) {
                      errorMessage = warningMatches[1];
                      var fileMatch = errorMessage.match(fileNotFoundErrorFind);
                      if (fileMatch) {
                          var lineIndex = findStringInLines(listLines, fileMatch[1]);
                          if (lineIndex > -1) {
                              lineNumber = listLines[lineIndex].number;
                              filename = listLines[lineIndex].filename;
                          }
                      }
                  }
              }
          }
          if (errorMessage) {
              var newLine_1 = {
                  number: lineNumber,
                  filename: filename,
                  address: -1,
                  bytes: undefined,
                  raw: outputLine,
                  errorMessage: errorMessage,
                  comment: undefined,
                  command: undefined,
              };
              if (lineNumbers.length > 0) {
                  // Applies to more than one line
                  lineNumbers.forEach(function (lineNumberItem, index) {
                      newLines.push(Object.assign({}, newLine_1, {
                          number: lineNumberItem,
                          filename: filenames[index],
                      }));
                  });
              }
              else {
                  // Just one line
                  newLines.push(newLine_1);
              }
          }
      });
      // Merge global errors with their lines
      return listLines ? mergeLinesWithGlobalErrors(listLines, newLines) : newLines;
  }
  function findStringInLines(lines, needle, startLineIndex) {
      if (startLineIndex === void 0) { startLineIndex = 0; }
      if (!lines)
          return -1;
      var commentStart;
      var lineRaw;
      for (var i = startLineIndex; i < lines.length; i++) {
          lineRaw = lines[i].raw;
          if (lineRaw) {
              commentStart = lineRaw.indexOf(";");
              if (commentStart > -1)
                  lineRaw = lineRaw.substr(0, commentStart);
              if (lineRaw.indexOf(needle) > -1)
                  return i;
          }
      }
      return -1;
  }
  function parseBytes(value) {
      var values = value.split(" ");
      var bytes = new Uint8Array(values.length);
      values.forEach(function (byteValue, index) {
          bytes[index] = parseInt(byteValue, 16);
      });
      return bytes;
  }
  function parseNumber(value) {
      value = value.trim().toLowerCase();
      var inValue = value.substr(1);
      if (value.substr(0, 1) === "0") {
          // Octal
          return parseInt(inValue, 8);
      }
      else if (value.substr(0, 1) === "%") {
          // Binary
          return parseInt(inValue, 2);
      }
      else if (value.substr(0, 1) === "u") {
          // Unsigned decimal integer (not documented?)
          return parseInt(inValue, 10);
      }
      else if (value.substr(0, 1) === "f") {
          // Hexadecimal (not documented?)
          return parseInt(inValue, 16);
      }
      else {
          console.warn("dasm list parsing error: number [" + value + "] could not be properly parsed with the known formats. Assuming decimal.");
          return parseInt(value, 10);
      }
  }
  function parseSymbols(symbolsFile, list) {
      var symbols = [];
      var lines = symbolsFile.split("\n");
      lines.forEach(function (line) {
          if (line.length === 47 && line.substr(0, 3) !== "---") {
              var name_1 = line.substr(0, 25).trim();
              var value = line.substr(25, 4).trim();
              var isLabel = value.substr(0, 1) === "f";
              var flags = line.substr(44, 2).trim();
              var definitionFilename = undefined;
              var definitionLineNumber = -1;
              var definitionColumnStart = -1;
              var definitionColumnEnd = -1;
              if (list) {
                  var definitionLine = list.find(function (listLine) { return listLine.command !== undefined && listLine.command.trim().startsWith(name_1); });
                  if (definitionLine) {
                      definitionFilename = definitionLine.filename;
                      definitionLineNumber = definitionLine.number;
                      definitionColumnStart = definitionLine.command ? definitionLine.command.indexOf(name_1) : -1;
                      definitionColumnEnd = definitionColumnStart > -1 ? definitionColumnStart + name_1.length : -1;
                  }
              }
              symbols.push({
                  name: name_1,
                  isLabel: isLabel,
                  isConstant: !isLabel,
                  value: parseInt(isLabel ? value.substr(1) : value, 16),
                  wasReferenced: Boolean(flags.match(/r/i)),
                  wasPseudoOpCreated: Boolean(flags.match(/s/i)),
                  definitionFilename: definitionFilename,
                  definitionLineNumber: definitionLineNumber,
                  definitionColumnStart: definitionColumnStart,
                  definitionColumnEnd: definitionColumnEnd,
              });
          }
      });
      return symbols;
  }
  function fileExists(FS, path) {
      var stream;
      try {
          stream = FS.open(path, "r");
      }
      catch (e) {
          return false;
      }
      FS.close(stream);
      return true;
  }
  function createFile(FS, path, contents, isBinary) {
      if (isBinary === void 0) { isBinary = false; }
      try {
          var folders = path.split("/");
          for (var i = 0; i < folders.length - 1; i++) {
              FS.mkdir(folders.slice(0, i + 1).join("/"));
          }
          FS.writeFile(path, contents, { encoding: isBinary ? "binary" : "utf8" });
      }
      catch (e) {
          console.error("Error writing file " + path, e);
      }
  }
  function createIncludeFiles(includes) {
      for (var _i = 0, includes_1 = includes; _i < includes_1.length; _i++) {
          var include = includes_1[_i];
          createFile(Module.FS, include.entryRelativeUri, include.contents, include.isBinary);
          createIncludeFiles(include.includes);
      }
  }
  /*
  // For testing purposes
  function showDirectory() {
      console.log(logDir(Module.FS.lookupPath("/", {}).node, 0));
  }

  function logDir(node, level) {
      const spaces = "                             ";
      let str = node.name;
      if (level < 6) {
          //str += "\n" + typeof(node.contents);
          if (!(node.contents instanceof Uint8Array)) {
              for (var ff in node.contents) {
                  str += "\n" + logDir(node.contents[ff], level + 1);
              }
          }
      }
      return spaces.substr(0, level * 2) + str;
  }
  */
  // Final export
  function default_1(src, options) {
      if (options === void 0) { options = {}; }
      // Prepare vars
      log.length = 0;
      didCompile = true;
      var moduleOptions = {
          noInitialRun: true,
          print: logLine,
          printErr: logErrorLine,
          ENVIRONMENT: "WEB",
      };
      Module = dasm.DASM(Object.assign({}, moduleOptions));
      // Prepare source
      Module.FS.writeFile(FILENAME_IN, src);
      // Prepare argument list
      var args = [];
      args.push("-o" + FILENAME_OUT);
      if (options.format) {
          args.push("-f" + options.format);
      }
      if (!options.quick) {
          args.push("-l" + FILENAME_LIST);
          args.push("-s" + FILENAME_SYMBOLS);
      }
      if (options.parameters) {
          args = args.concat(options.parameters.split(" "));
      }
      if (options.machine) {
          args.push("-I" + "/machines/" + options.machine + "/");
      }
      // Include files as needed
      if (options.includes) {
          if (Array.isArray(options.includes)) {
              // Arrays of IInclude
              createIncludeFiles(options.includes);
          }
          else {
              // Object with key uri:value contents
              for (var fileName in options.includes) {
                  var content = options.includes[fileName];
                  createFile(Module.FS, fileName, content, typeof (content) !== "string");
              }
          }
          // showDirectory();
      }
      // Finally, call it
      try {
          Module.callMain([FILENAME_IN].concat(args));
      }
      catch (e) {
          // Fatal error: impossible to determine why
          didCompile = false;
          console.error("Fatal error when calling module", e);
      }
      // Get other output files
      var listFile = undefined;
      var symbolsFile = undefined;
      if (!options.quick) {
          if (fileExists(Module.FS, FILENAME_SYMBOLS))
              symbolsFile = Module.FS.readFile(FILENAME_SYMBOLS, { encoding: "utf8" });
          if (fileExists(Module.FS, FILENAME_LIST))
              listFile = Module.FS.readFile(FILENAME_LIST, { encoding: "utf8" });
      }
      // The list can also include injected data from the output
      var list = listFile ? parseList(listFile) : undefined;
      if (list) {
          list = parseListFromOutput(list, log);
      }
      // Return results
      return {
          data: fileExists(Module.FS, FILENAME_OUT) ? (Module.FS.readFile(FILENAME_OUT)) : new Uint8Array(0),
          output: log.concat(),
          list: list,
          listRaw: listFile,
          symbols: symbolsFile ? parseSymbols(symbolsFile, list ? list : []) : undefined,
          symbolsRaw: symbolsFile,
          exitStatus: Module.getStatus(),
          success: didCompile,
      };
  }
  exports.default = default_1;
  });

  unwrapExports(lib);
  var lib_1 = lib.resolveIncludes;

  const dasm$1 = lib.default;

  const code = `

  processor 6502
  include "vcs.h"
  include "macro.h"

  org  $1000

  
Start  

  lda PFBitmap5
  sta COLUPF

  lda #%10010101
  sta PF0
  sta PF1
  sta PF2
  lda #%00000000
  sta CTRLPF

NextFrame
; Enable VBLANK (disable output)
  lda #2
  sta VBLANK
        
; At the beginning of the frame we set the VSYNC bit...
  lda #2
  sta VSYNC
        
; And hold it on for 3 scanlines...
  REPEAT 3
    sta WSYNC
  REPEND
        
; Now we turn VSYNC off.
  lda #0
  sta VSYNC

; Now we need 37 lines of VBLANK...
  REPEAT 37
    sta WSYNC  ; accessing WSYNC stops the CPU until next scanline
  REPEND

; Re-enable output (disable VBLANK)
  lda #0
  sta VBLANK
        
; 192 scanlines are visible
; We'll draw some rainbows
  ldx #0
  REPEAT 192
    inx
    stx COLUBK
    sta WSYNC
  REPEND

; Enable VBLANK again
  lda #2
  sta VBLANK
        
; 30 lines of overscan to complete the frame
  REPEAT 30
    sta WSYNC
  REPEND
  
; Go back and do another frame
  jmp NextFrame

PFBitmap5
  .byte 92

  org $1ffc
  .word Start
  .word Start


`;

  const WIDTH = 160;
  const HEIGHT = 192;

  const initiateCanvas = () => {
    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    return ctx;
  };

  const run = async () => {

    const codeAreaElement = document.getElementById("code");
    codeAreaElement.value = code;

    const ctx = initiateCanvas();

    const updateDisplay = (screenBuffer) => {
      const imageData = ctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < WIDTH * HEIGHT * 4; i++) {
        imageData.data[i] = screenBuffer[i];
      }
      ctx.putImageData(imageData, 0, 0);
    };

    const buildAndRun = async () => {
      const module = await loader.instantiateStreaming(
        fetch("/build/untouched.wasm")
      );
      const memory = module.Memory.wrap(module.consoleMemory);
      const tia = module.TIA.wrap(module.tia);
      const buffer = module.__getArrayView(memory.buffer);

      // compile with DASM
      const result = dasm$1(codeAreaElement.value, {
        format: 3,
        machine: "atari2600"
      });

      // copy RAM to Atari program memory
      result.data.forEach((byte, index) => {
        buffer[index + 0x1000] = byte;
      });

      tia.tick(228 * 262);
      updateDisplay(module.__getArray(tia.display));
    };

    document.getElementById("run").addEventListener("click", buildAndRun);
    buildAndRun();
  };

  run();

  var main = {

  };

  return main;

}(fs, path, crypto));

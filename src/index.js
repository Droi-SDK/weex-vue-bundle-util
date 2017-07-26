var request = require('request')
var astw = require('astw-babylon')
var path = require('path')
var fs = require('fs')
var exec = require('child_process').execSync

var backupInfo = require('../data/info.json')
var dataUrl = 'http://g.alicdn.com/weex/weex-vue-bundle-tool/info.json'

var getMetaInfo = function () {
  return new Promise(function (resolve, reject) {
    request(dataUrl, function (err, res, body) {
      if (err) {
        resolve(backupInfo)
      }
      else {
        resolve(JSON.parse(body))
      }
    })
  })
}

var isArray = function (arr) {
  return Object.prototype.toString.call(arr) === '[object Array]'
}

var extend = function () {
  var to = arguments[0]
  var froms = Array.prototype.slice.call(arguments, 1)
  froms.forEach(function (from) {
    for (var key in from) {
      if (from.hasOwnProperty(key)) {
        to[key] = from[key]
      }
    }
  })
  return to
}

var getDeferred = function () {
  var deferred = {}
  deferred.promise = new Promise(function (resolve, reject) {
    deferred.resolve = resolve
    deferred.reject = reject
  })
  return deferred
}

var genVueOptions = function (options, checkMap, allMap) {
  if (typeof options === 'object') {
    if (!options.compilerModules) {
      options.compilerModules = []
    }
    options.compilerModules.push({
      postTransformNode: function (el) {
        if (checkMap.hasOwnProperty(el.tag)) {
          checkMap[el.tag]++
        }
        if (!allMap[el.tag]) {
          allMap[el.tag] = 1
        }
        else {
          allMap[el.tag]++
        }
      }
    })
  }
  return options
}

var parseAssets = function (assets, options) {
  var output = options && options.output
  var defer = getDeferred()
  var nodes = {}
  assets.forEach(function (asset) {
    var p = path.resolve(output.path, asset.name)
    var file = fs.readFileSync(p)
    var walk = astw(file.toString('utf8'))
    var parentNode
    walk(function (node) {
      if (node.name === 'requireModule'
        && (parentNode = node.parent)
        && parentNode.type === 'MemberExpression'
        // && parentNode.object.name === 'weex'
        && (parentNode = parentNode.parent)
        && parentNode.type === 'CallExpression') {
        var value = parentNode.arguments[0].value
        if (nodes[value]) {
          nodes[value]++
        }
        else {
          nodes[value] = 1
        }
      }
    })
  })
  defer.resolve(nodes)
  return defer.promise
}

var outputImportEntryFile = function (filePath, pkgs) {
  var names = []
  var str = pkgs.map(function (pkgName) {
    var name = pkgName
      .replace('weex-vue-', '')
      .replace(/-(\w)/g, function ($0, $1) {
        return $1.toUpperCase()
      })
      + 'Mod'
    names.push(name)
    try {
      var version = require(`${pkgName}/package.json`).version
    } catch (err) {
      console.log(` => install ${pkgName}...`)
      exec(`npm install ${pkgName}`)
    }
    return `import ${name} from '${pkgName}'\n`
  }).join('')
  str += `export default [\n  ${names.join(',  \n')}\n]\n`
  return fs.writeFileSync(filePath, str)
}

/**
 * webpack config structure:
 * 1. http://webpack.github.io/docs/using-loaders.html#configuration
 * 2. https://webpack.js.org/guides/migrating/
 * 3. https://webpack.js.org/configuration/
 */

/**
 * options:
 *  - ali: Boolean. build for @ali/weex-vue-render, with ali built-in components.
 *  - output: String. file path to output import statements.
 */
function scan (webpack, webpackConfig, options) {
  return getMetaInfo()
    .then(function (info) {
      var builtInPkgMap = info['built-in']
      var builtInComponentMap = builtInPkgMap.component
      var builtInModuleMap = builtInPkgMap.module
      var aliPkgMap = info['ali']
      var aliComponentMap = aliPkgMap.component
      var aliModuleMap = aliPkgMap.module
      var ignoreComponents = info['ignore']
      var componentMap = {}
      var moduleMap = {}
      var nodes = {}
      var allNodes = {}

      for (var key in builtInComponentMap) {
        nodes[key] = 0
        componentMap[key] = builtInComponentMap[key]
      }
      extend(moduleMap, builtInModuleMap)
      ignoreComponents.forEach(function (comp) {
        delete nodes[comp]
        delete componentMap[comp]
      })
      if (options && options.ali) {
        for (var key in aliComponentMap) {
          nodes[key] = 0
          componentMap[key] = aliComponentMap[key]
        }
        extend(moduleMap, aliModuleMap)
      }

      var config = extend({}, webpackConfig)
      var deferred = getDeferred()

      var mod = config.module
      var rules = mod.rules || mod.loaders
      if (!rules) {
        return console.error('webpack config missing rules.')
      }
      var is2 = !!mod.rules
      if (is2) {  // webpack 2.0
        rules.forEach(function (rule) {
          if (rule.use && isArray(rule.use)) { // use multiple loaders.
            var vueLoaderIndex = -1
            rule.use.forEach(function (use, idx) {
              if (typeof use === 'string' && use.match(/vue-loader/)) {
                vueLoaderIndex = idx
              }
              else if (typeof use === 'object' && use.loader.match(/vue-loader/)) {
                use.options = genVueOptions(use.options, nodes, allNodes)
              }
            })
            if (vueLoaderIndex > -1) {
              var options = genVueOptions({}, nodes, allNodes)
              rules.use[vueLoaderIndex] = {
                loader: use,
                options
              }
            }
          }
        })
      }
      else {  // webpack 1.0
        config.vue = genVueOptions(config.vue || {}, nodes, allNodes)
      }
      var loaders = webpackConfig.module.loaders
      webpack(webpackConfig, function (err, stats) {
        if (err) {
          console.error('[weex-vue-bundle-util] error:', err)
          deferred.reject(err)
        }
        else {
          var info = stats.toJson()
          if (stats.hasErrors()) {
            var error = info.errors
            console.error('[weex-vue-bundle-util] webpack compiling error:', error)
          }
          var parseAssetsOptions = {
            output: config.output
          }
          parseAssets(info.assets, parseAssetsOptions)
            .then(function (modules) {
              var pkgMap = {}
              var res = {
                components: {},
                modules: {},
                pkgs: []
              }
              for (var key in nodes) {
                if (nodes[key] > 0) {
                  var pkgName = componentMap[key]
                  res.components[key] = pkgName
                  pkgMap[pkgName] = true
                }
              }
              for (var key in modules) {
                if (modules[key] > 0 && moduleMap[key]) {
                  var pkgName = moduleMap[key]
                  res.modules[key] = pkgName
                  pkgMap[pkgName] = true
                }
              }
              res.pkgs = Object.keys(pkgMap)
              if (res.pkgs && res.pkgs.length > 0 && options && options.output) {
                var outputPath = options.output
                outputImportEntryFile(outputPath, res.pkgs)
              }
              deferred.resolve(res)
            })
        }
      })
      return deferred.promise
    })
}

module.exports = scan

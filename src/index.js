var request = require('request')
var astw = require('astw-babylon')
var path = require('path')
var fs = require('fs')

var backupComponentInfo = require('../data/component.json')
var dataUrl = 'http://g-assets.daily.taobao.net/weex/weex-vue-bundle-tool/component.json'

var getMetaInfo = function () {
  return new Promise(function (resolve, reject) {
    request(dataUrl, function (err, res, body) {
      if (err) {
        resolve(backupComponentInfo)
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

var genVueOptions = function (options, nodeCountMap, checkMap) {
  if (typeof options === 'object') {
    if (!options.compilerModules) {
      options.compilerModules = []
    }
    options.compilerModules.push({
      postTransformNode: function (el) {
        if (checkMap.hasOwnProperty(el.tag)) {
          checkMap[el.tag]++
        }
      }
    })
  }
  return options
}

var parseAssets = function (assets) {
  var defer = getDeferred()
  var nodes = {}
  assets.forEach(function (asset) {
    var p = path.resolve(process.cwd(), asset.name)
    var file = fs.readFileSync(p)
    var walk = astw(file.toString('utf8'))
    var parentNode
    walk(function (node) {
      if (node.name === 'requireModule'
        && (parentNode = node.parent)
        && parentNode.type === 'MemberExpression'
        && parentNode.object.name === 'weex'
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

/**
 * webpack config structure:
 * 1. http://webpack.github.io/docs/using-loaders.html#configuration
 * 2. https://webpack.js.org/guides/migrating/
 * 3. https://webpack.js.org/configuration/
 */

/**
 * options:
 *  - ali: Boolean. build for @ali/weex-vue-render, with ali built-in components.
 */
function scan (webpack, webpackConfig, options) {
  return getMetaInfo()
    .then(function (info) {
      var builtInComponentMap = info['built-in']
      var aliComponentMap = info['ali']
      var ignoreComponentMap = info['ignore']

      var checkComponentMap = extend({}, builtInComponentMap)
      if (options && options.ali) {
        extend(checkComponentMap, aliComponentMap)
      }
      for (var key in ignoreComponentMap) {
        delete checkComponentMap[key]
      }

      var config = extend({}, webpackConfig)
      var deferred = getDeferred()

      var nodes = extend({}, checkComponentMap)
      var mod = config.module
      var rules = mod.rules || mod.loaders
      if (!rules) {
        return console.error('webpack config missing rules.')
      }
      let is2 = !!mod.rules
      if (is2) {  // webpack 2.0
        rules.forEach(function (rule) {
          if (rule.use && isArray(rule.use)) { // use multiple loaders.
            let vueLoaderIndex = -1
            rule.use.forEach(function (use, idx) {
              if (typeof use === 'string' && use.match(/vue-loader/)) {
                vueLoaderIndex = idx
              }
              else if (typeof use === 'object' && use.loader.match(/vue-loader/)) {
                use.options = genVueOptions(use.options, nodes, nodes)
              }
            })
            if (vueLoaderIndex > -1) {
              var options = genVueOptions({}, nodes, nodes)
              rules.use[vueLoaderIndex] = {
                loader: use,
                options
              }
            }
          }
        })
      }
      else {  // webpack 1.0
        config.vue = genVueOptions(config.vue || {}, nodes, nodes)
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
          parseAssets(info.assets)
            .then(function (modules) {
              var res = {
                modules,
                components: nodes
              }
              deferred.resolve(res)
            })
        }
      })
      return deferred.promise
    })
}

module.exports = scan

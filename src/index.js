var path = require('path')
var fs = require('fs')
var exec = require('child_process').execSync
var request = require('request')
var astw = require('astw-babylon')
var resolveCwd = require('resolve-cwd')
var semver = require('semver')

var backupInfo = require('../data/info.json')
var dataUrl = 'http://g.alicdn.com/weex/weex-vue-bundle-tool/info.json'

var ignorePeerDependencies = [
  'weex-vue-render',
  '@ali/weex-vue-render',
  'vue-loader'
]

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

var installPkg = function (name, versionRange) {
  var fullName = `${name}${versionRange ? '@' + versionRange : ''}`
  var pkgMgrTool = name.match(/^@ali\//) ? 'tnpm' : 'npm'
  console.log(` => ${pkgMgrTool} install ${fullName}...`)
  return exec(`${pkgMgrTool} install ${name}`)
}

var getInstalledPkgInfo = function (name, versionRange) {
  try {
    var pkgPath = resolveCwd(`${name}/package.json`)
    var pkg = require(pkgPath)
    if (versionRange) {
      var isSatisfy = semver.satisfies(pkg.version, versionRange)
      if (!isSatisfy) {
        installPkg(name, versionRange)
      }
    }
    return pkg
  } catch (err) {
    installPkg(name, versionRange)
    return getInstalledPkgInfo(name)
  }
}

var getPkgModName = function (pkgName) {
  return pkgName
    .replace(/@ali\//, 'ali-')
    .replace('weex-vue-', '')
    .replace(/-(\w)/g, function ($0, $1) {
      return $1.toUpperCase()
    })
    + 'Mod'
}

var processPkgs = function (pkgs, options) {
  var options = options || {}
  var output = options.output
  var names = []
  var peerDependencies = {}
  var shouldImportPeerDependencies = {}
  var str = pkgs.map(function (pkgName) {
    var name = getPkgModName(pkgName)
    names.push(name)
    if (options.allowInstallPlugins) {
      var pkg = getInstalledPkgInfo(pkgName)
      if (pkg) {
        var depPkgs = pkg.peerDependencies
        extend(peerDependencies, depPkgs)
        if (options.allowInstallPluginDependencies) {
          for (var key in depPkgs) {
            if (ignorePeerDependencies.indexOf(key) <= -1) {
              getInstalledPkgInfo(key, depPkgs[key])
            }
          }
        }
      }
    }
    return `import ${name} from '${pkgName}'\n`
  }).join('')
  // for peerDependencies: just import, no export to default array.
  str = Object.keys(peerDependencies).map(function (pkgName) {
    if (ignorePeerDependencies.indexOf(pkgName) <= -1) {
      return `import '${pkgName}'\n`
    }
    else return ''
  }).join('') + str
  str += `export default [\n  ${names.join(',\n  ')}\n]\n`
  if (output) {
    fs.writeFileSync(output, str)
  }
  return {
    peerDependencies
  }
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
 *  - allowInstallPlugins: Boolean. If true, the dependend plugins will be auto installled, and
 *    only this be true the peerDependencies of the plugins could be analyzed and
 *    output to the result object.
 *  - allowInstallPluginDependencies: Boolean. If true, the peerDependencies of the plugins
 *    will be auto installed and be imported in the plugin entry file.
 *  - allowInstallRenderCore: Boolean. If true and the dependend version of weex-vue-render
 *    in the peerDependencies of the plugins will be auto installed.
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
                res.peerDependencies = processPkgs(res.pkgs, options)
              }
              deferred.resolve(res)
            })
        }
      })
      return deferred.promise
    })
}

module.exports = scan

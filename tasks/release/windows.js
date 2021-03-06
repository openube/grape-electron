'use strict';

var Q = require('q');
var gulpUtil = require('gulp-util');
var childProcess = require('child_process');
var jetpack = require('fs-jetpack');
var asar = require('asar');
var utils = require('../utils');

var upgradeCode = '0BAA1F0D-A23D-4092-A61A-E3284D8541CB';

var projectDir;
var tmpDir;
var releasesDir;
var readyAppDir;
var manifest;
var exeName;

var init = function() {
    projectDir = jetpack;
    tmpDir = projectDir.dir('./tmp', { empty: true });
    releasesDir = projectDir.dir('./releases');
    manifest = projectDir.read('app/package.json', 'json');
    exeName = manifest.productName + '.exe';
    readyAppDir = tmpDir.cwd(manifest.name);

    return Q();
};

var copyRuntime = function() {
    return projectDir.copyAsync(
      'node_modules/electron/dist',
      readyAppDir.path(),
      { overwrite: true }
    );
};

var cleanupRuntime = function() {
    return readyAppDir.removeAsync('resources/default_app');
};

var packageBuiltApp = function() {
    var deferred = Q.defer();

    asar.createPackage(projectDir.path('build'), readyAppDir.path('resources/app.asar'), function() {
        deferred.resolve();
    });

    return deferred.promise;
};

var finalize = function() {

    projectDir.copy('resources/windows/icon.ico', readyAppDir.path('icon.ico'));
    projectDir.copy('resources/windows/grapefile_client.exe', readyAppDir.path('grapefile_client.exe'));

    var rcedit = require('rcedit');
    var electronExePromise = Q.defer()
    var fileCilentExePropmise = Q.defer()

    // Replace Electron icon for your own.
    rcedit(readyAppDir.path('electron.exe'), {
        'icon': projectDir.path('resources/windows/icon.ico'),
        'version-string': {
            'ProductName': manifest.productName,
            'FileDescription': manifest.description,
            'ProductVersion': manifest.version,
            'CompanyName': manifest.author, // it might be better to add another field to package.json for this
            'LegalCopyright': manifest.copyright,
            'OriginalFilename': exeName
        }
    }, function (err) {
        if (!err) {
            electronExePromise.resolve();
            // Replace Default icon at grapefile_client.
            rcedit(readyAppDir.path('grapefile_client.exe'), {
                'icon': projectDir.path('resources/windows/icon.ico')
            }, function (err) {
                if (!err) {
                    fileCilentExePropmise.resolve()
                }
            });
        }
    });

    return Q.all([electronExePromise.propmise, fileCilentExePropmise.promise]);
};

var renameApp = function() {
    return readyAppDir.renameAsync(
      'electron.exe',
      exeName
    );
};

var signApp = function() {
    var password = utils.getSigningId();
    var cert = utils.getCert();
    var deferred = Q.defer();
    if (password) {
      console.log(releasesDir.path(utils.finalPackageName(manifest, 'msi')))
      var sign = childProcess.spawn('signtool', [
          'sign',
          '/f',
          cert,
          '/p',
          password,
          '/td',
          'SHA256',
          releasesDir.path(utils.finalPackageName(manifest, 'msi'))
      ], {
        stdio: 'inherit'
      });
      sign.on('error', function (err) {
        throw err;
      });
      sign.on('close', function() {
        gulpUtil.log('App signed!');
        deferred.resolve();
      });
    } else {
        return Q();
    }
}

var generateListOfFiles = function() {
    var deferred = Q.defer();

    gulpUtil.log('Building installer with WIX...');

    gulpUtil.log('Running HEAT to generate a files list for feature...');

    // Note: WIX DIR have to be added to PATH (environment variables).
    var heat = childProcess.spawn('heat', [
        'dir',
        readyAppDir.path(),
        '-cg',
        'ApplicationFiles',
        '-dr',
        'INSTALLDIR',
        '-v',
        '-sw5150',
        '-gg',
        '-g1',
        '-sreg',
        '-sfrag',
        '-srd',
        '-out',
        tmpDir.path('files.wxl')
    ], {
        stdio: 'inherit'
    });
    heat.on('error', function (err) {
        if (err.message === 'spawn heat ENOENT') {
            throw "Can't find HEAT. Are you sure you've installed WIX and"
            + " added to PATH environment variable?";
        } else {
            throw err;
        }
    });
    heat.on('close', function() {
        gulpUtil.log('File generated!');
        deferred.resolve();
    });

    return deferred.promise;
};

var runCandleForMsi = function() {
    var deferred = Q.defer();

    gulpUtil.log('Converting LICENSE file to rtf...');

    var license = projectDir.read('resources/windows/LICENSE');

    license = utils.convertToRtf(license);

    tmpDir.write('LICENSE.rtf', license);

    var fragment = projectDir.read('tmp/files.wxl');

    fragment = fragment.replace(new RegExp('SourceDir', 'g'), readyAppDir.path());

    projectDir.write('tmp/files.wxl', fragment);

    var wixFile = projectDir.read('resources/windows/installer.wxl');

    wixFile = utils.replace(wixFile, {
        name: manifest.name,
        productName: manifest.productName,
        exeName: exeName,
        version: manifest.version,
        icon: readyAppDir.path('icon.ico'),
        topBanner: projectDir.path('resources/windows/top.bmp'),
        leftBanner: projectDir.path('resources/windows/left.bmp'),
        ico32: projectDir.path('resources/windows/icon.ico'),
        ico16: projectDir.path('resources/windows/icon.ico'),
        license: tmpDir.path('LICENSE.rtf'),
        upgradeCode: upgradeCode,
        manufacturer : manifest.author
    });


    tmpDir.write('installer.wxl', wixFile);

    gulpUtil.log('Running CANDLE to compile a wix objects for MSI...');

    // Note: WIX DIR have to be added to PATH (environment variables).
    var candle = childProcess.spawn('candle', [
        tmpDir.path('installer.wxl'),
        tmpDir.path('files.wxl'),
        '-ext',
        'WixUIExtension.dll',
        '-ext',
        'WixUtilExtension.dll',
        '-out',
        tmpDir.path() + '\\'
    ], {
        stdio: 'inherit'
    });

    candle.on('error', function (err) {
        if (err.message === 'spawn candle ENOENT') {
            throw "Can't find CANDLE. Are you sure you've installed WIX and"
            + " added to PATH environment variable?";
        } else {
            throw err;
        }
    });

    candle.on('close', function() {
        gulpUtil.log('Wix object compiled!');
        deferred.resolve();
    });

    return deferred.promise;
};

var runLightForMsi = function() {
    var deferred = Q.defer();

    var finalPackageName = utils.finalPackageName(manifest, 'msi')

       gulpUtil.log('Running Light to create an MSI installer...');

    // Note: WIX DIR have to be added to PATH (environment variables).
    var light = childProcess.spawn('light', [
        '-out',
        releasesDir.path(finalPackageName),
        '-ext',
        'WixUIExtension.dll',
        '-ext',
        'WixUtilExtension.dll',
        '-sw1076',
        tmpDir.path('installer.wixobj'),
        tmpDir.path('files.wixobj')

    ], {
        stdio: 'inherit'
    });

    light.on('error', function (err) {
        if (err.message === 'spawn candle ENOENT') {
            throw "Can't find LIGHT. Are you sure you've installed WIX and"
            + " added to PATH environment variable?";
        } else {
            throw err;
        }
    });
    light.on('close', function() {
        gulpUtil.log('Wix object compiled!');
        deferred.resolve();
    });

    return deferred.promise;
};

var runCandleForBootstraper = function() {
    var deferred = Q.defer();

    var wixFile = projectDir.read('resources/windows/bootstraper.wxl');

    wixFile = utils.replace(wixFile, {
        productName: manifest.productName,
        exeName: exeName,
        logo: projectDir.path('resources/windows/grape_64.png'),
        version: manifest.version,
        icon: readyAppDir.path('icon.ico'),
        license: tmpDir.path('LICENSE.rtf'),
        upgradeCode: upgradeCode,
        manufacturer: manifest.author,
        msi: releasesDir.path(utils.finalPackageName(manifest, 'msi'))
    });

    tmpDir.write('bootstraper.wxl', wixFile);

    gulpUtil.log('Running CANDLE to compile a wix objects for bootstraper...');

    // Note: WIX DIR have to be added to PATH (environment variables).
    var candle = childProcess.spawn('candle', [
        tmpDir.path('bootstraper.wxl'),
        '-ext',
        'WixBalExtension.dll',
        '-ext',
        'WixUIExtension.dll',
        '-ext',
        'WixUtilExtension.dll',
        '-out',
        tmpDir.path() + '\\'
    ], {
        stdio: 'inherit'
    });

    candle.on('error', function (err) {
        if (err.message === 'spawn candle ENOENT') {
            throw "Can't find CANDLE. Are you sure you've installed WIX and"
            + " added to PATH environment variable?";
        } else {
            throw err;
        }
    });

    candle.on('close', function() {
        gulpUtil.log('Wix object compiled!');
        deferred.resolve();
    });

    return deferred.promise;
};

var runLightForBootstraper  = function() {
    var deferred = Q.defer();

    var finalPackageName = utils.finalPackageName(manifest, 'exe')

    gulpUtil.log('Running Light to create an bootstraper installer...');

    // Note: WIX DIR have to be added to PATH (environment variables).
    var light = childProcess.spawn('light', [
        '-out',
        releasesDir.path(finalPackageName),
        '-ext',
        'WixBalExtension.dll',
        '-ext',
        'WixUIExtension.dll',
        '-ext',
        'WixUtilExtension.dll',
        tmpDir.path('bootstraper.wixobj')
    ], {
        stdio: 'inherit'
    });

    light.on('error', function (err) {
        if (err.message === 'spawn candle ENOENT') {
            throw "Can't find LIGHT. Are you sure you've installed WIX and"
            + " added to PATH environment variable?";
        } else {
            throw err;
        }
    });
    light.on('close', function() {
        gulpUtil.log('Wix object compiled!');
        deferred.resolve();
    });

    return deferred.promise;
};

var createInstaller = function() {
  return generateListOfFiles()
    .then(runCandleForMsi)
    .then(runLightForMsi)
    .then(runCandleForBootstraper)
    .then(runLightForBootstraper);
};

var cleanClutter = function() {
    return tmpDir.removeAsync('.');
};

module.exports = function() {
    return init()
        .then(copyRuntime)
        .then(cleanupRuntime)
        .then(packageBuiltApp)
        .then(finalize)
        .then(renameApp)
        .then(createInstaller)
        .then(cleanClutter)
        .then(signApp)
        .catch(console.error);
};

'use strict';
var Path = require('path');
var Fs = require('fs');
var Crypto = require('crypto');
var streamifier = require('streamifier');
var toArray = require('stream-to-array');
var tar = require('tar-stream');
var request = require('request');
var requestp = require('request-promise');

var config = require(Path.join(__dirname, 'config'));

var cert = Fs.readFileSync(Path.resolve(__dirname, config.cert_path));
var key = Fs.readFileSync(Path.resolve(__dirname, config.key_path));
var ca = Fs.readFileSync(Path.resolve(__dirname, config.update_server_ca_cert));
var signing_key = Fs.readFileSync(Path.resolve(__dirname, config.signing_server_pubkey));

function checkForUpdates () {
  console.log('uLinux Device Updater Daemon: Checking for updates');
  return new Promise(function(resolve, reject) {

    requestp.post({
      url: 'https://' + config.update_server + '/newUpdate',
      cert: cert,
      key: key,
      ca: ca,
      form: {
        timestamp: getLatestUpdateTimestamp(),
      },
      json: true
    }).then(function (res) {
      if (res.message) {
        resolve(res.updateId);
      } else {
        reject('No new update found!');
      }
    }).catch(function (err) {
      var wrapper = new Error('Got an error checking for updates');
      wrapper.cause = err;
      reject(wrapper);
    });

  });
}

function getLatestUpdateTimestamp() {
  var timestamp;

  try {
    timestamp = parseInt(Fs.readFileSync(
      Path.join(config.image_path, '..', 'last_update'),  { encoding: 'UTF-8' }
    ));
  } catch (error) {
    // File does not exist (never updated before), use UNIX epoch
    timestamp = 0;
  }

  return timestamp;
}

function downloadImage (updateId) {
  console.log('uLinux Device Updater Daemon: Downloading update with id ' + updateId);
  return new Promise(function(resolve, reject) {

    request.get({
      url: 'https://' + config.update_server + '/updates/' + updateId,
      cert: cert,
      key: key,
      ca: ca,
      encoding: null,
    }, function (err, response, body) {
      if (err) {
        var wrapper = new Error('Got an error retrieving the update image.');
        wrapper.cause = err;
        reject(wrapper);
      }
      else if (response.headers['content-type'].indexOf('application/json') != -1) {
        // Some error message
        var wrapper = new Error('Got an error retrieving the update image.');
        try {
          wrapper.cause = JSON.parse(new String(body, 'UTF-8'));
        } catch (e) {
          wrapper.cause =
            new Error('Could not parse error message produced by the API');
        }
        reject(wrapper);
      } else {
        // We're actually getting the file
        resolve(body);
      }
    });
  });
}

function verifyImage (buffer) {
  console.log('uLinux Device Updater Daemon: Verifying image');
  var pack = streamifier.createReadStream(buffer);
  var extract = tar.extract();

  var image, signature;

  return new Promise(function(resolve, reject) {
    extract.on('entry', function(header, stream, callback) {
      // header is the tar header
      // stream is the content body (might be an empty stream)
      // call next when you are done with this entry

      toArray(stream)
        .then(function (parts) {
          // concatenate all the array entries into the same buffer
          var buffers = [];
          for (var i = 0, l = parts.length; i < l ; ++i) {
            var part = parts[i];
            buffers.push((part instanceof Buffer) ? part : new Buffer(part));
          }

          var resBuffer = Buffer.concat(buffers);

          if (header.name === 'signature.txt') {
            signature = resBuffer.toString();
          }

          if (header.name === 'image.img') {
            image = resBuffer;
          }

          callback(); // tar-stream requires calling this to begin nexy entry
        });

    });

    var verify = Crypto.createVerify('RSA-SHA512');
    extract.on('finish', function () {
      if (!signature || !image) {
        reject(new Error('Signature or image is missing from downloaded tar file.'));
      } else {
        verify.write(image);
        verify.end();
        if(verify.verify(signing_key, signature, 'base64')){
          resolve(image);
        } else {
          reject(new Error('Image signature was not successfully verified.'));
        }
      }
    });

    pack.pipe(extract);

  });
}

function writeImageToDisk (buffer) {
  console.log('uLinux Device Updater Daemon: writing image to disk');
  Fs.writeFile(config.image_path, buffer, function (err) {
    if (err) {
      console.log(err);
    }
  });
  // Save the timestamp for this update
  Fs.writeFile(Path.join(config.image_path, '..', 'last_update'), Math.round(Date.now()/1000), function (err) {
    if (err) {
      console.log(err);
    }
  });

}

function reboot () {
  // Perform reboot
  console.log('uLinux Device Updater Daemon: Rebooting device');
}

function performUpdate() {
  checkForUpdates()
    .then(downloadImage)
    .then(verifyImage)
    .then(writeImageToDisk)
    .then(reboot)
    .catch(function (err) {
      console.error('uLinux Device Updater Daemon:', err);
    });
}

setInterval(performUpdate, config.polling_interval * 1000);
performUpdate();

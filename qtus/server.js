'use strict'

const path = require('path')
const fs = require('fs')
const axios = require('axios');

const { Server, EVENTS } = require('@tus/server')
const { FileStore } = require('@tus/file-store');
const { env } = require('process');

const projects_env = process.env.PROJECTS;
const has_notifications_env = process.env.HAS_NOTIFICATION;
const directory = process.env.DIRECTORY;

const rootDirectory = path.join(__dirname, '../');
const directoryPath = path.join(rootDirectory, directory);

const projects_env_array = projects_env.split("|").filter(item => item); // ["hpdrones", "qimob", "tus-server"]
const projects_env_with_notifications_array = has_notifications_env.split("|").filter(item => item); // ["hpdrones", "qimob", "tus-server"]

const completedDirectoryPath = Object.fromEntries(
  projects_env_array.map(project => [project, path.join(directoryPath, `${project}/completed/`)])
);


if (!fs.existsSync(directoryPath)) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

for (const [key, value] of Object.entries(completedDirectoryPath)) {
  if (!fs.existsSync(value)) {
    fs.mkdirSync(value, { recursive: true });
  }
}


const stores = {
  FileStore: () => new FileStore({ directory: directoryPath }),
};

const storeName = process.env.DATA_STORE || 'FileStore'
const store = stores[storeName]
const server = new Server({ path: '/files', datastore: store() })

server.on(EVENTS.POST_FINISH, (req, res, upload) => {
  console.log(
    `[${new Date().toLocaleTimeString()}] [EVENT HOOK] Upload complete for file ${upload.id}`
  );

  const jsonFilePath = path.join(directoryPath, upload.id + '.json');
  let project = '';
  let app = '';
  let model = '';
  

  console.log('Reading metadata file...');
  fs.readFile(jsonFilePath, 'utf8', (err, data) => {
    if (err) {
      console.error(err);
      return;
    }
    const obj = JSON.parse(data);

    console.log('Checking if project is in metadata...');
    if ('project' in obj.metadata) {
      project = obj.metadata.project;
      app = obj.metadata.app;
      model = obj.metadata.model;
      obj.metadata.size = obj.size;
      obj.metadata.id = obj.id;
      obj.metadata.creation_date = obj.creation_date;
      console.log('OBJ:', obj); 
      console.log(project);
      console.log('Apply logic to move file to completed folder...');

      projects_env_array.forEach(project_arr => {
        if (project === project_arr) {

          console.log(`Moving file to ${project} completed folder`);
          let completedDirectoryPathNotification = path.join(completedDirectoryPath[project], upload.id);
          fs.copyFile(
            path.join(directoryPath, upload.id),
            path.join(completedDirectoryPath[project], upload.id),
            (copyErr) => {
              if (copyErr) {
                console.error(copyErr);
              } else {
                console.log(`File ${upload.id} copied to the completed folder`);
                if (projects_env_with_notifications_array.includes(project)) {
                  console.log(`Notifying backend of upload...`);
                  loginAndGetToken()
                      .then((authToken) => {
                        console.log('Token before making the second request:', authToken);
                        
                        return uploadNotification(authToken, project, app, obj.metadata, completedDirectoryPathNotification);
                      })
                      .catch((error) => {
                        console.error('Error:', error.message);
                      });
                }
                console.log(`Deleting original file ${upload.id}`);
                fs.unlink(path.join(directoryPath, upload.id), (unlinkErr) => {
                  if (unlinkErr) {
                    console.error(unlinkErr);
                  } else {
                    console.log(`Original file ${upload.id} deleted`);
                    fs.unlink(path.join(directoryPath, upload.id + '.json'), (unlinkErr) => {
                      if (unlinkErr) {
                        console.error(unlinkErr);
                      } else {
                        console.log(`Original JSON file for ${upload.id} deleted`);
                        fs.unlink(jsonFilePath, (jsonUnlinkErr) => {
                          if (jsonUnlinkErr) {
                            console.error(jsonUnlinkErr);
                          } else {
                            console.log(`Original JSON file for ${upload.id} deleted`);
                          }
                        });
                      }
                    }
                    );
                  }
                });
              }
            }
          );
          
        }

      });

    } else {
      console.log('No project key in metadata');
    }
  });
});

const writeFile = (req, res) => {
  console.log('Preparing Download...');

  const uploadMetadata = req.headers['upload-metadata'];

  if (!uploadMetadata) {
    res.writeHead(400, {'Content-Type': 'text/plain'});
    res.write('Upload-Metadata header is missing');
    res.end();
    return;
  }

  const metadataArray = uploadMetadata.split(',');
  const metadataObj = metadataArray.reduce((acc, item) => {
    const [key, value] = item.split(' ');
    acc[key] = value;
    return acc;
  }, {});

  const { id } = metadataObj;

  if (!id) {
    res.writeHead(400, {'Content-Type': 'text/plain'});
    res.write('ID is missing in the Upload-Metadata header');
    res.end();
    return;
  }

  let filename = path.join(completedDirectoryPath['hpdrones'], id);

  console.log(`Reading file ${filename}...`);

  fs.readFile(filename, (err, file) => {
    if (err) {
      res.writeHead(500, {'Content-Type': 'text/plain'});
      res.write(err.message);
      res.end();
      return;
    }

    // Set Content-Disposition header to trigger download
    res.setHeader('Content-Disposition', `attachment; filename=${id}`);
    res.writeHead(200);
    res.write(file);
    res.end();
  });
};

server.get('/downloads', writeFile);

server.get('/uploads', (req, res) => {
  const files_path = completedDirectoryPath['hpdrones'];
  fs.readdir(files_path, (err, filenames) => {
      const files = filenames.map((filename) => {
          return {
              name: filename,
              url: `http://${host}:${port}/${filename}`,
          };
      });

      res.writeHead(200);
      res.write(JSON.stringify({ files }));
      res.end();
  });
});

function loginAndGetToken() {
  return new Promise(async (resolve, reject) => {
    try {
      // Login Request
      const loginUrl = process.env.BACKEND_AUTH_URL;
      const loginCredentials = {
        email: process.env.BACKEND_EMAIL,
        password: process.env.BACKEND_PASS
      };

      const loginResponse = await axios.post(loginUrl, loginCredentials);
      
      const authToken = loginResponse.data.access;

      console.log('Login Successful. Token:', authToken);
      resolve(authToken);
    } catch (error) {
      console.error('Error during login:', error.message);
      reject(error);
    }
  });
}

function uploadNotification(authToken, project, app, metadata, filepath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Second Request
      const uploadUrl = process.env.BACKEND_NOTIFICATION_URL;
      const notificationData = {
        project: project,
        app: app,
        filepath: filepath,
        metadata: metadata
      };

      const uploadResponse = await axios.post(uploadUrl, notificationData, {
        headers: {
          Authorization: `Token ${authToken}`
        }
      });

      console.log('Upload Response:', uploadResponse.data);
      resolve(uploadResponse.data);
    } catch (error) {
      console.error('Error during upload:', error.message);
      reject(error);
    }
  });
}



const host = '0.0.0.0'
const port = 1080

server.listen({ host, port }, () => {
  console.log(
    `[${new Date().toLocaleTimeString()}] tus server listening at http://${host}:${port} using ${storeName}`
  )
})

import { PDFExtract, PDFExtractOptions } from 'pdf.js-extract';
import * as fs from 'fs';

const path = 'factsheets';

const pdfExtractViaJsExtract = () => {
  const pdfExtract = new PDFExtract();
  const options: PDFExtractOptions = {};

  const filesArray = fs
    .readdirSync(path)
    .filter((file) => fs.lstatSync(`${path}/${file}`).isFile())
    .map((file) => `${path}/${file}`);

  const promises = [];

  const startTime = Date.now();

  filesArray.forEach((file) => {
    promises.push(
      new Promise((resolve, reject) => {
        pdfExtract
          .extract(file, options)
          .then((data) => {
            let content = '';
            data.pages.forEach((page) => {
              page.content.forEach((cnt) => {
                if (cnt.str) {
                  content += ` ${cnt.str}`;
                }
              });
            });
            resolve(content);
          })
          .catch((err) => {
            console.log(err);
            reject();
          });
      })
    );
  });

  Promise.all(promises).then((values) => {
    const endTime = Date.now();
    console.log('DONE extract text from pdf in', endTime - startTime, 'ms');
    const data = [...values].join('\n');
    fs.writeFileSync('pdf-text.txt', data);
  });
};

pdfExtractViaJsExtract();

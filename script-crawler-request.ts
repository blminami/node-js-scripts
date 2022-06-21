import * as crawler from 'crawler-request';
import * as fs from 'fs';

const urls = [
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/brochure_appzillon-mobile-corporate-banking.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-07/factsheet-abaka-ai-powered-next-besta-action.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/brochure_kapitalwise-factsheet.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-12/factsheet_aio.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/brochure_appzillon-corporate-onboarding-app.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/product-insights_allied-bill-payment-factsheet.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-08/factsheet_antuar.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/brochure_appzillon-mobile-corporate-banking.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-02/brochure_bankbi.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2022-05/factsheet-beauceron.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2022-01/factsheet_cecl-express.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-08/factsheet_clari5-aml-system_0.pdf',
  'https://www.fusionfabric.cloud/sites/default/files/files/2021-08/factsheet_clari5-efm-system.pdf'
];

const pdfExtractViaPdfCrawler = () => {
  const promises = [];

  const startTime = Date.now();

  urls.forEach((url) => {
    promises.push(
      new Promise((resolve, reject) => {
        crawler(url)
          .then((response) => {
            const content = response.text;
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
    fs.writeFileSync('pdf-crawler.txt', data);
  });
};

pdfExtractViaPdfCrawler();

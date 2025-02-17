import * as fs from 'fs';
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';


// Adds tokens per second to models.json by checking throughput on openrouter.ai

interface RouterModelData {
  data: RouterModel[];
}

interface RouterModel {
  slug: string;
  [key: string]: any;
}

interface ModelData {
  object: string;
  data: Model[];
}

interface Model {
  id: string;
  throughput?: number;
  [key: string]: any;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchThroughputWithRetry(
  driver: any,
  url: string,
  modelId: string,
  maxRetries: number = 3
): Promise<number | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await driver.get(url);

      await driver.wait(
        until.elementLocated(
          By.css('link[href*="d575595c16fc6eb9.css"]')
        ),
        10000
      );

      try {
        const throughputLabel = await driver.findElement(
          By.xpath("//div[text()='Throughput']")
        );

        const throughputValue = await driver.findElement(
          By.xpath("//div[text()='Throughput']/following-sibling::div")
        );

        const throughputValueText = await throughputValue.getText();

        if (!throughputValueText) {
          console.log(`Throughput value not found for ${modelId}. Skipping.`);
          return null;
        }

        return parseFloat(throughputValueText.replace('t/s', '').trim());
      } catch (elementError) {
        console.log(`Throughput value not found for ${modelId}. Skipping.`);
        return null;
      }
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(`Final attempt failed for ${modelId}:`, error);
        return null;
      }
      console.log(
        `Attempt ${attempt} failed for ${modelId}, retrying in 10 seconds...`
      );
      await sleep(10000);
    }
  }
  return null;
}

async function main() {
  const routerJsonData = fs.readFileSync(
    './dev/routermodels.json',
    'utf-8'
  );
  const routerModels: RouterModelData = JSON.parse(routerJsonData);

  const modelsJsonData = fs.readFileSync('./models.json', 'utf-8');
  const modelsData: ModelData = JSON.parse(modelsJsonData);

  const options = new chrome.Options();

  options.addArguments('--no-sandbox');
  const driver = new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

  for (const routerModel of routerModels.data) {
    const slug = routerModel.slug;
    const url = `https://openrouter.ai/${slug}`;

    const slugParts = slug.split('/');
    if (slugParts.length < 2) {
      console.log(`Invalid slug format: ${slug}. Skipping.`);
      continue;
    }

    const modelIdFromSlug = slugParts[1];

    const model = modelsData.data.find((m) => m.id === modelIdFromSlug);

    if (!model) {
      console.log(
        `Model ${modelIdFromSlug} not found in models.json. Skipping.`
      );
      continue;
    }

    const throughput = await fetchThroughputWithRetry(
      driver,
      url,
      model.id
    );

    if (throughput !== null) {
      model.throughput = throughput;
      console.log(`Added throughput ${throughput} to model ${model.id}`);
    }
  }

  await driver.quit();

  const filePath = './models.json';
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ object: 'list', data: [] }, null, 2),
      'utf-8'
    );
  }

  fs.writeFileSync(
    filePath,
    JSON.stringify(modelsData, null, 2),
    'utf-8'
  );
  console.log('Updated models.json with throughput values.');
}

main();
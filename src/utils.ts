import core = require('@actions/core');
import fs = require('fs');
import path = require('path');
import xml = require('xml2js');

/**
 * Common paths where Windows SDK versions are typically installed.
 */
const windowsKitPaths = [
  'C:\\Program Files (x86)\\Windows Kits\\10\\Include',
  'C:\\Program Files\\Windows Kits\\10\\Include'
];
/**
 * Detects the available Windows SDK version on the build machine
 */
export async function getAvailableWindowsSDKVersion(): Promise<string | null> {
  const allVersions: string[] = [];
  for (const basePath of windowsKitPaths) {
    try {
      await fs.promises.access(basePath, fs.constants.R_OK);
      const entries = await fs.promises.readdir(basePath);
      const versions = entries.filter(entry => /^10\.0\.\d+\.\d+$/.test(entry));
      allVersions.push(...versions);
      core.debug(`Found Windows SDK versions in ${basePath}:`);
      versions.forEach(version => core.debug(`  - ${version}`));
    } catch (error) {
      continue;
    }
  }
  if (allVersions.length === 0) {
    throw new Error('No Windows SDK versions found in standard installation paths.');
  }
  // Remove duplicates and sort versions in descending order to prefer the latest
  const uniqueVersions = [...new Set(allVersions)].sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) {
        return bVal - aVal; // Descending order
      }
    }
    return 0;
  });
  core.info(`All available Windows SDK versions:`);
  uniqueVersions.forEach(version => core.info(`  - ${version}`));
  return uniqueVersions[0]; // Return the latest version
}
/**
 * Checks if a specific Windows SDK version is available on the build machine
 */
export async function isWindowsSDKVersionAvailable(version: string): Promise<boolean> {
  for (const basePath of windowsKitPaths) {
    try {
      const versionPath = path.join(basePath, version);
      await fs.promises.access(versionPath, fs.constants.R_OK);
      core.info(`Found Windows SDK version ${version} at: ${versionPath}`);
      return true;
    } catch (error) {
      continue;
    }
  }
  core.warning(`Windows SDK version ${version} not found in standard locations.`);
  return false;
}
/**
 * Parses an XML file and returns the parsed object
 * @param filePath The path to the XML file to parse
 */
export async function parseXml(filePath: string): Promise<any> {
  const fileContent: string = fs.readFileSync(filePath, 'utf8');
  const parser = new xml.Parser();
  return await parser.parseStringPromise(fileContent);
}
/**
 * Writes an XML file
 * @param filePath The path to the XML file to write
 * @param xmlObject The object to convert to XML
 */
export async function writeXml(filePath: string, xmlObject: any): Promise<void> {
  const builder = new xml.Builder({
    xmldec: {
      version: '1.0',
      encoding: 'utf-8',
      standalone: null
    },
    renderOpts: {
      pretty: true,
      indent: '  ',
      newline: '\n',
    },
    headless: false
  });
  await fs.promises.writeFile(filePath, builder.buildObject(xmlObject), 'utf8');
}
/**
 * Prints the contents of a file to the action log
 * @param filePath The path to the file to print
 */
export async function printFileContents(filePath: string): Promise<void> {
  const fileHandle = await fs.promises.open(filePath, 'r');
  try {
    const content = await fileHandle.readFile('utf8');
    core.startGroup(`----- ${filePath} -----`);
    core.info(content);
    core.endGroup();
  } catch (error) {
    core.error(`Failed to read file ${filePath}: ${error}`);
  } finally {
    await fileHandle.close();
  }
}
/**
 * Removes the WindowsMobile SDKReference from the vcxproj file if it exists
 * This is necessary for Windows SDK versions >= 10.0.26100.0 since it is no longer supported
 */
export async function removeWindowsMobileSDKReference(vcxprojPath: string): Promise<boolean> {
  const xmlObj = await parseXml(vcxprojPath);
  let found = false;
  if (xmlObj.Project && xmlObj.Project.ItemGroup) {
    let itemGroups = Array.isArray(xmlObj.Project.ItemGroup)
      ? xmlObj.Project.ItemGroup
      : [xmlObj.Project.ItemGroup];
    itemGroups = itemGroups.filter((group: any) => {
      if (group.SDKReference) {
        const sdkRefs = Array.isArray(group.SDKReference) ? group.SDKReference : [group.SDKReference];
        const hasWindowsMobile = sdkRefs.some((sdkRef: any) => {
          if (sdkRef.$ && sdkRef.$.Include && sdkRef.$.Include.includes('WindowsMobile')) {
            found = true;
            return true;
          }
          return false;
        });
        if (hasWindowsMobile) {
          return false;
        }
      }
      return true;
    });
    xmlObj.Project.ItemGroup = itemGroups.length === 1 ? itemGroups[0] : itemGroups;
  }
  if (xmlObj.Project && xmlObj.Project.SDKReference) {
    let sdkRefs = Array.isArray(xmlObj.Project.SDKReference)
      ? xmlObj.Project.SDKReference
      : [xmlObj.Project.SDKReference];
    sdkRefs = sdkRefs.filter((sdkRef: any) => {
      if (sdkRef.$ && sdkRef.$.Include && sdkRef.$.Include.includes('WindowsMobile')) {
        found = true;
        return false;
      }
      return true;
    });
    if (sdkRefs.length === 0) {
      delete xmlObj.Project.SDKReference;
    } else {
      xmlObj.Project.SDKReference = sdkRefs.length === 1 ? sdkRefs[0] : sdkRefs;
    }
  }
  if (found) {
    core.info(`Found WindowsMobile SDKReference in ${vcxprojPath}. Removing...`);
    await writeXml(vcxprojPath, xmlObj);
    core.info(`Removed WindowsMobile SDKReference from ${vcxprojPath}`);
    // printFileContents(vcxprojPath);
  } else {
    core.info(`No WindowsMobile SDKReference found in ${vcxprojPath}`);
  }
  return found;
}
/**
 * Associates the UWP project with the Microsoft Store using the provided StoreAssociationFile.
 * This function copies the StoreAssociationFile to the project directory, updates the vcxproj file
 * to include the StoreAssociationFile, and updates the Package.appxmanifest with the identity information
 * from the StoreAssociationFile.
 * It also updates the vcxproj file to set the AppxBundlePlatforms based on the Package.StoreAssociation.xml file.
 * @param vcxprojPath The path to the vcxproj file of the UWP project.
 * @param sourcePackageAssociationFilePath The path to the source StoreAssociationFile to copy.
 * @see https://learn.microsoft.com/en-us/windows/apps/develop/app-package-identity
 * @see https://learn.microsoft.com/en-us/windows/apps/develop/app-package-store-association
 * @see https://learn.microsoft.com/en-us/windows/apps/develop/appx-bundle-platforms
 */
export async function associateAppWithStore(vcxprojPath: string, sourcePackageAssociationFilePath: string): Promise<void> {
  const packageStoreAssociationFilePath = await copyPackageStoreAssociationFile(vcxprojPath, sourcePackageAssociationFilePath);
  const packageStoreAssociationXml = await parseXml(packageStoreAssociationFilePath);
  const appxManifestPath = path.join(path.dirname(vcxprojPath), 'Package.appxmanifest');
  await fs.promises.access(appxManifestPath, fs.constants.R_OK | fs.constants.W_OK);
  const appxManifestXml = await parseXml(appxManifestPath);
  if (appxManifestXml.Package.Identity && Array.isArray(appxManifestXml.Package.Identity)) {
    appxManifestXml.Package.Identity[0].$.Name = packageStoreAssociationXml.StoreAssociation.ProductReservedInfo[0].MainPackageIdentityName[0];
    appxManifestXml.Package.Identity[0].$.Publisher = packageStoreAssociationXml.StoreAssociation.PublisherDisplayName[0];
  }
  if (appxManifestXml.Package.Properties && Array.isArray(appxManifestXml.Package.Properties)) {
    appxManifestXml.Package.Properties[0].DisplayName = [packageStoreAssociationXml.StoreAssociation.ProductReservedInfo[0].ReservedNames[0].ReservedName[0]];
    appxManifestXml.Package.Properties[0].PublisherDisplayName = [packageStoreAssociationXml.StoreAssociation.PublisherDisplayName[0]];
  }
  if (appxManifestXml.Package.Applications && Array.isArray(appxManifestXml.Package.Applications)) {
    const app = appxManifestXml.Package.Applications[0].Application?.[0];
    if (app && app['uap:VisualElements'] && Array.isArray(app['uap:VisualElements'])) {
      app['uap:VisualElements'][0].$.DisplayName = packageStoreAssociationXml.StoreAssociation.ProductReservedInfo[0].ReservedNames[0].ReservedName[0];
    }
  }
  await writeXml(appxManifestPath, appxManifestXml);
  core.info(`Updated Package.appxmanifest with identity information from ${packageStoreAssociationFilePath}`);
  await printFileContents(appxManifestPath);
}
/**
 * Copies the Package.StoreAssociation.xml file to the project directory and updates the vcxproj file to reference it.
 * This is necessary for uploading the package to the Microsoft Store.
 * @param vcxprojPath The path to the vcxproj file of the UWP project.
 * @param sourcePackageAssociationFilePath The path to the source Package.StoreAssociation.xml file.
 */
export async function copyPackageStoreAssociationFile(vcxprojPath: string, sourcePackageAssociationFilePath: string): Promise<string> {
  const packageStoreAssociationFilePath = path.join(path.dirname(vcxprojPath), 'Package.StoreAssociation.xml');
  await fs.promises.access(sourcePackageAssociationFilePath, fs.constants.R_OK | fs.constants.W_OK);
  await fs.promises.copyFile(sourcePackageAssociationFilePath, packageStoreAssociationFilePath);
  const vcxProjXml = await parseXml(vcxprojPath);
  let hasStoreAssociationFile: boolean = false;
  const itemGroups = Array.isArray(vcxProjXml.Project.ItemGroup) ? vcxProjXml.Project.ItemGroup : [vcxProjXml.Project.ItemGroup];
  for (const group of itemGroups) {
    if (group.None) {
      if (Array.isArray(group.None)) {
        for (const noneItem of group.None) {
          if (noneItem.$ && noneItem.$.Include === 'Package.StoreAssociation.xml') {
            hasStoreAssociationFile = true;
            break;
          }
        }
      } else if (group.None.$ && group.None.$.Include === 'Package.StoreAssociation.xml') {
        hasStoreAssociationFile = true;
        break;
      }
    }
    if (hasStoreAssociationFile) break;
  }
  if (!hasStoreAssociationFile) {
    core.info('Package.StoreAssociation.xml not referenced in vcxproj, updating...');
    itemGroups.push({
      None: [{ $: { Include: 'Package.StoreAssociation.xml' } }]
    });
    vcxProjXml.Project.ItemGroup = itemGroups;
  }
  const propertyGroups = Array.isArray(vcxProjXml.Project.PropertyGroup) ? vcxProjXml.Project.PropertyGroup : [vcxProjXml.Project.PropertyGroup];
  let hasGenerateTemporaryStoreCertificate: boolean = false;
  for (const group of propertyGroups) {
    if (group.GenerateTemporaryStoreCertificate === 'true' || (group.GenerateTemporaryStoreCertificate && group.GenerateTemporaryStoreCertificate[0] === 'true')) {
      hasGenerateTemporaryStoreCertificate = true;
      break;
    }
  }
  if (!hasGenerateTemporaryStoreCertificate) {
    core.info('GenerateTemporaryStoreCertificate is not set to true, updating...');
    propertyGroups.push({ GenerateTemporaryStoreCertificate: ['true'] });
  }
  vcxProjXml.Project.PropertyGroup = propertyGroups;
  await writeXml(vcxprojPath, vcxProjXml);
  await printFileContents(vcxprojPath);
  return packageStoreAssociationFilePath;
}
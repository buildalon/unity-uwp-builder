import core = require('@actions/core');
import fs = require('fs');
import path = require('path');
import {
  XMLParser,
  XMLBuilder
} from 'fast-xml-parser';

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
  const fileContent: string = fs.readFileSync(filePath).toString('utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true
  });
  return parser.parse(fileContent);
}
/**
 * Writes an XML file
 * @param filePath The path to the XML file to write
 * @param xmlObject The object to convert to XML
 */
export async function writeXml(filePath: string, xmlObject: any): Promise<void> {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    preserveOrder: true
  });
  const xmlContent = builder.build(xmlObject);
  await fs.promises.writeFile(filePath, xmlContent, 'utf8');
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
export async function removeWindowsMobileSDKReference(vcxprojPath: string): Promise<void> {
  const vcxprojXml = await parseXml(vcxprojPath);
  let found = false;
  for (const node of vcxprojXml) {
    if (node.Project) {
      for (const item of node.Project) {
        if (item.ItemGroup) {
          for (const group of item.ItemGroup) {
            if (group.SDKReference) {
              let sdkRefs = Array.isArray(group.SDKReference) ? group.SDKReference : [group.SDKReference];
              const originalLength = sdkRefs.length;
              sdkRefs = sdkRefs.filter((ref: { [x: string]: any; Include: any; }) => {
                const include = ref['@_Include'] || ref.Include;
                if (include && include.includes('WindowsMobile')) {
                  found = true;
                  return false;
                }
                return true;
              });
              if (sdkRefs.length !== originalLength) {
                group.SDKReference = sdkRefs.length === 1 ? sdkRefs[0] : sdkRefs;
              }
            }
          }
        }
      }
    }
  }
  if (found) {
    core.info(`Found WindowsMobile SDKReference in ${vcxprojPath}. Removing...`);
    await writeXml(vcxprojPath, vcxprojXml);
    core.info(`Removed WindowsMobile SDKReference from ${vcxprojPath}`);
    printFileContents(vcxprojPath);
  } else {
    core.info(`No WindowsMobile SDKReference found in ${vcxprojPath}`);
  }
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
  appxManifestXml.Package.Identity['@_Name'] = packageStoreAssociationXml.StoreAssociation.ProductReservedInfo.MainPackageIdentityName;
  appxManifestXml.Package.Identity['@_Publisher'] = packageStoreAssociationXml.StoreAssociation.PublisherDisplayName;
  appxManifestXml.Package.Properties['@_DisplayName'] = packageStoreAssociationXml.StoreAssociation.ProductReservedInfo.ReservedNames.ReservedName;
  appxManifestXml.Package.Properties['@_PublisherDisplayName'] = packageStoreAssociationXml.StoreAssociation.PublisherDisplayName;
  appxManifestXml.Applications.Application.VisualElements['@_DisplayName'] = packageStoreAssociationXml.StoreAssociation.ProductReservedInfo.ReservedNames.ReservedName;
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
async function copyPackageStoreAssociationFile(vcxprojPath: string, sourcePackageAssociationFilePath: string): Promise<string> {
  const packageStoreAssociationFilePath = path.join(path.dirname(vcxprojPath), 'Package.StoreAssociation.xml');
  // check if the source file exists, and is readable and writable
  await fs.promises.access(sourcePackageAssociationFilePath, fs.constants.R_OK | fs.constants.W_OK);
  await fs.promises.copyFile(sourcePackageAssociationFilePath, packageStoreAssociationFilePath);
  const vcxProjXml = await parseXml(vcxprojPath);
  let hasStoreAssociationFile: boolean = false;
  // Check if Package.StoreAssociation.xml is already referenced using parsed vcxProjXml.
  const itemGroups = vcxProjXml.Project.ItemGroup || [];
  for (const group of itemGroups) {
    if (group.None && group.None['@_Include'] === 'Package.StoreAssociation.xml') {
      hasStoreAssociationFile = true;
      break;
    }
  }
  if (!hasStoreAssociationFile) {
    core.info('Package.StoreAssociation.xml not referenced in vcxproj, updating...');
    // add the new item group to the vcxprojXml under the Project root. Expect that the project root is a valid object.
    // expect that there are multiple ItemGroup nodes. We need to add it to the ItemGroup that does not contain any attributes.
    const itemGroups = vcxProjXml.Project.ItemGroup || [];
    itemGroups.push({
      ItemGroup: {
        None: {
          '@_Include': 'Package.StoreAssociation.xml'
        }
      }
    });
    vcxProjXml.Project.ItemGroup = itemGroups;
  }
  // check if PropertyGroup GenerateTemporaryStoreCertificate is set to true, if not, add it or update it
  const propertyGroups = vcxProjXml.Project.PropertyGroup || [];
  let hasGenerateTemporaryStoreCertificate: boolean = false;
  for (const group of propertyGroups) {
    if (group.GenerateTemporaryStoreCertificate === 'true') {
      hasGenerateTemporaryStoreCertificate = true;
      break;
    }
  }
  if (!hasGenerateTemporaryStoreCertificate) {
    core.info('GenerateTemporaryStoreCertificate is not set to true, updating...');
    propertyGroups.push({
      PropertyGroup: {
        GenerateTemporaryStoreCertificate: 'true'
      }
    });
  }
  vcxProjXml.Project.PropertyGroup = propertyGroups;
  await writeXml(vcxprojPath, vcxProjXml);
  await printFileContents(vcxprojPath);
  return packageStoreAssociationFilePath;
}
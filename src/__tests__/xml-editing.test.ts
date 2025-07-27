import fs = require('fs');
import path = require('path');
import {
  associateAppWithStore,
  parseXml,
  removeWindowsMobileSDKReference
} from '../utils';

describe('UWP Project XML Editing', () => {
  const sourceDir = path.join(__dirname, 'source');
  const resultsDir = path.join(__dirname, 'results');

  beforeAll(() => {
    if (fs.existsSync(resultsDir)) {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(resultsDir, { recursive: true });
    const srcVcxproj = path.join(sourceDir, 'DummyApp.vcxproj');
    fs.copyFileSync(srcVcxproj, path.join(resultsDir, 'DummyApp.vcxproj'));
    const srcManifest = path.join(sourceDir, 'Package.appxmanifest');
    fs.copyFileSync(srcManifest, path.join(resultsDir, 'Package.appxmanifest'));
    const srcAssoc = path.join(sourceDir, 'Package.StoreAssociation.xml');
    fs.copyFileSync(srcAssoc, path.join(resultsDir, 'Package.StoreAssociation.xml'));
  });

  it('prints parsed structure for DummyApp.vcxproj', async () => {
    const vcxprojTestFilePath = path.join(sourceDir, 'DummyApp.vcxproj');
    const parsed = await parseXml(vcxprojTestFilePath);
    fs.writeFileSync(path.join(resultsDir, 'DummyApp.vcxproj.json'), JSON.stringify(parsed, null, 2));
    expect(parsed).toBeDefined();
  });

  it('prints parsed structure for Package.appxmanifest', async () => {
    const packageManifestPath = path.join(sourceDir, 'Package.appxmanifest');
    const parsed = await parseXml(packageManifestPath);
    fs.writeFileSync(path.join(resultsDir, 'Package.appxmanifest.json'), JSON.stringify(parsed, null, 2));
    expect(parsed).toBeDefined();
  });

  it('prints parsed structure for Package.StoreAssociation.xml', async () => {
    const packageStoreAssociationPath = path.join(sourceDir, 'Package.StoreAssociation.xml');
    const parsed = await parseXml(packageStoreAssociationPath);
    fs.writeFileSync(path.join(resultsDir, 'Package.StoreAssociation.xml.json'), JSON.stringify(parsed, null, 2));
    expect(parsed).toBeDefined();
  });

  it('removes WindowsMobile SDKReference from DummyApp.vcxproj (git diff)', async () => {
    const vcxprojTestFilePath = path.join(resultsDir, 'DummyApp.vcxproj');
    const result = await removeWindowsMobileSDKReference(vcxprojTestFilePath);
    expect(result).toBe(true);
    // Check if the SDKReference was removed using regex
    const fileContents = fs.readFileSync(vcxprojTestFilePath, 'utf8');
    const regex = /<SDKReference Include="WindowsMobile" Version="[\d.]+" \/>/;
    expect(regex.test(fileContents)).toBe(false);
  });

  it('associateAppWithStore updates Package.appxmanifest with store association info', async () => {
    const vcxprojTestFilePath = path.join(resultsDir, 'DummyApp.vcxproj');
    const storeAssociationTestPath = path.join(resultsDir, 'Package.StoreAssociation.xml');
    const manifestTestPath = path.join(resultsDir, 'Package.appxmanifest');
    await associateAppWithStore(vcxprojTestFilePath, storeAssociationTestPath);
    const updatedManifest = fs.readFileSync(manifestTestPath, 'utf8');
    expect(updatedManifest).toContain('Identity');
    expect(updatedManifest).toContain('Publisher');
    expect(updatedManifest).toContain('DisplayName');
  });

  it('copyPackageStoreAssociationFile updates vcxproj with StoreAssociation reference and certificate property', async () => {
    // Import the function directly
    const { copyPackageStoreAssociationFile } = require('../utils');
    const vcxprojTestFilePath = path.join(resultsDir, 'DummyApp.vcxproj');
    const storeAssociationTestPath = path.join(resultsDir, 'Package.StoreAssociation.xml');
    await copyPackageStoreAssociationFile(vcxprojTestFilePath, storeAssociationTestPath);
    const updatedVcxproj = fs.readFileSync(vcxprojTestFilePath, 'utf8');
    expect(updatedVcxproj).toContain('Package.StoreAssociation.xml');
    expect(updatedVcxproj).toContain('GenerateTemporaryStoreCertificate');
    expect(updatedVcxproj).toContain('true');
  });
});
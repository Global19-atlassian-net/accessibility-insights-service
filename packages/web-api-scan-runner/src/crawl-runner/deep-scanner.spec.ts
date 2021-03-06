// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import 'reflect-metadata';

import { DiscoveryPatternFactory } from 'accessibility-insights-crawler';
import { CrawlConfig, ServiceConfiguration } from 'common';
import { GlobalLogger } from 'logger';
import { Page } from 'scanner-global-library';
import { WebsiteScanResultProvider } from 'service-library';
import { OnDemandPageScanResult, WebsiteScanResult } from 'storage-documents';
import { IMock, It, Mock } from 'typemoq';
import * as Puppeteer from 'puppeteer';
import { WebsiteScanResultWriter } from '../runner/website-scan-result-writer';
import { ScanMetadata } from '../types/scan-metadata';
import { DiscoveredUrlProcessor } from './discovered-url-processor';
import { CrawlRunner } from './crawl-runner';
import { DeepScanner } from './deep-scanner';
import { ScanFeedGenerator } from './scan-feed-generator';

describe(DeepScanner, () => {
    let loggerMock: IMock<GlobalLogger>;
    let crawlRunnerMock: IMock<CrawlRunner>;
    let websiteScanResultProviderMock: IMock<WebsiteScanResultProvider>;
    let serviceConfigMock: IMock<ServiceConfiguration>;
    let websiteScanResultWriterMock: IMock<WebsiteScanResultWriter>;
    let urlProcessorMock: IMock<DiscoveredUrlProcessor>;
    let discoveryPatternGeneratorMock: IMock<DiscoveryPatternFactory>;
    let pageMock: IMock<Page>;
    let scanFeedGeneratorMock: IMock<ScanFeedGenerator>;
    const puppeteerPageStub = {} as Puppeteer.Page;

    const url = 'test url';
    const urlCrawlLimit = 5;
    const crawlConfig = { urlCrawlLimit } as CrawlConfig;
    const websiteScanResultId = 'websiteScanResult id';
    const knownPages = ['knownUrl1', 'knownUrl2'];
    const discoveredUrls = ['discoveredUrl1', 'discoveredUrl2'];
    const processedUrls = ['processedUrl1', 'processedUrl2'];
    const discoveryPatterns = ['discovery pattern'];
    const crawlBaseUrl = 'base url';
    let scanMetadata: ScanMetadata;
    let pageScanResult: OnDemandPageScanResult;
    let websiteScanResult: WebsiteScanResult;
    let websiteScanResultDbDocument: WebsiteScanResult;

    let testSubject: DeepScanner;

    beforeEach(() => {
        loggerMock = Mock.ofType<GlobalLogger>();
        crawlRunnerMock = Mock.ofType<CrawlRunner>();
        websiteScanResultProviderMock = Mock.ofType<WebsiteScanResultProvider>();
        serviceConfigMock = Mock.ofType<ServiceConfiguration>();
        websiteScanResultWriterMock = Mock.ofType<WebsiteScanResultWriter>();
        urlProcessorMock = Mock.ofType<DiscoveredUrlProcessor>();
        discoveryPatternGeneratorMock = Mock.ofType<DiscoveryPatternFactory>();
        pageMock = Mock.ofType<Page>();
        scanFeedGeneratorMock = Mock.ofType<ScanFeedGenerator>();

        serviceConfigMock.setup((sc) => sc.getConfigValue('crawlConfig')).returns(() => Promise.resolve(crawlConfig));
        pageMock.setup((p) => p.getUnderlyingPage()).returns(() => puppeteerPageStub);
        scanMetadata = {
            url: url,
            deepScan: true,
            id: 'scan id',
        };
        pageScanResult = {
            url: url,
            websiteScanRefs: [
                { id: 'some id', scanGroupType: 'consolidated-scan-report' },
                { id: websiteScanResultId, scanGroupType: 'deep-scan' },
            ],
        } as OnDemandPageScanResult;
        websiteScanResult = {
            id: websiteScanResultId,
            knownPages: knownPages,
            discoveryPatterns: discoveryPatterns,
            baseUrl: crawlBaseUrl,
        } as WebsiteScanResult;
        websiteScanResultDbDocument = {
            ...websiteScanResult,
            _etag: 'etag',
        };

        testSubject = new DeepScanner(
            crawlRunnerMock.object,
            scanFeedGeneratorMock.object,
            websiteScanResultProviderMock.object,
            websiteScanResultWriterMock.object,
            serviceConfigMock.object,
            loggerMock.object,
            urlProcessorMock.object,
            discoveryPatternGeneratorMock.object,
        );
    });

    afterEach(() => {
        loggerMock.verifyAll();
        crawlRunnerMock.verifyAll();
        websiteScanResultProviderMock.verifyAll();
        websiteScanResultWriterMock.verifyAll();
        urlProcessorMock.verifyAll();
        discoveryPatternGeneratorMock.verifyAll();
        scanFeedGeneratorMock.verifyAll();
    });

    it('skip deep scan if maximum discovered pages limit was reached', async () => {
        websiteScanResult.knownPages = [];
        for (let i = 0; i < urlCrawlLimit + 1; i++) {
            websiteScanResult.knownPages.push(`i`);
        }
        setupReadWebsiteScanResult();
        setupLoggerProperties();
        loggerMock
            .setup((o) =>
                o.logInfo('The website deep scan completed since maximum discovered pages limit was reached.', {
                    discoveredUrlsTotal: (urlCrawlLimit + 1).toString(),
                    discoveredUrlsLimit: urlCrawlLimit.toString(),
                }),
            )
            .verifiable();

        await testSubject.runDeepScan(scanMetadata, pageScanResult, pageMock.object);
    });

    it('logs and throws if websiteScanRefs is missing', () => {
        pageScanResult.websiteScanRefs = undefined;

        loggerMock.setup((l) => l.logError(It.isAny(), It.isAny())).verifiable();

        expect(testSubject.runDeepScan(scanMetadata, pageScanResult, pageMock.object)).rejects.toThrow();
    });

    it('crawls and updates results with generated discovery pattern', async () => {
        websiteScanResult.discoveryPatterns = undefined;
        const generatedDiscoveryPattern = 'new discovery pattern';
        setupLoggerProperties();
        discoveryPatternGeneratorMock
            .setup((d) => d(crawlBaseUrl))
            .returns(() => generatedDiscoveryPattern)
            .verifiable();
        setupReadWebsiteScanResult();
        setupCrawl([generatedDiscoveryPattern]);
        setupProcessUrls();
        setupUpdateWebsiteScanResult([generatedDiscoveryPattern]);
        setupScanFeedGeneratorMock();

        await testSubject.runDeepScan(scanMetadata, pageScanResult, pageMock.object);
    });

    it('crawls and updates results with previously existing discovery pattern', async () => {
        setupReadWebsiteScanResult();
        setupLoggerProperties();
        setupCrawl(discoveryPatterns);
        setupProcessUrls();
        setupUpdateWebsiteScanResult(discoveryPatterns);
        setupScanFeedGeneratorMock();

        await testSubject.runDeepScan(scanMetadata, pageScanResult, pageMock.object);
    });

    function setupScanFeedGeneratorMock(): void {
        scanFeedGeneratorMock.setup((o) => o.queueDiscoveredPages(websiteScanResultDbDocument, pageScanResult)).verifiable();
    }

    function setupReadWebsiteScanResult(): void {
        websiteScanResultProviderMock.setup((w) => w.read(websiteScanResultId)).returns(() => Promise.resolve(websiteScanResult));
    }

    function setupCrawl(crawlDiscoveryPatterns: string[]): void {
        crawlRunnerMock
            .setup((c) => c.run(url, crawlDiscoveryPatterns, puppeteerPageStub))
            .returns(() => Promise.resolve(discoveredUrls))
            .verifiable();
    }

    function setupProcessUrls(): void {
        urlProcessorMock
            .setup((u) => u(discoveredUrls, urlCrawlLimit, knownPages))
            .returns(() => processedUrls)
            .verifiable();
    }

    function setupUpdateWebsiteScanResult(crawlDiscoveryPatterns: string[]): void {
        websiteScanResultWriterMock
            .setup((w) => w.updateWebsiteScanResultWithDiscoveredUrls(pageScanResult, processedUrls, crawlDiscoveryPatterns))
            .returns(() => Promise.resolve(websiteScanResultDbDocument))
            .verifiable();
    }

    function setupLoggerProperties(): void {
        loggerMock
            .setup((l) =>
                l.setCommonProperties(
                    It.isValue({
                        websiteScanId: websiteScanResultId,
                    }),
                ),
            )
            .verifiable();
    }
});

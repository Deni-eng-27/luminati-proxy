// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, mocha:true*/
const _ = require('lodash');
const nock = require('nock');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const request = require('request');
const sinon = require('sinon');
const Manager = require('../lib/manager.js');
const cities = require('../lib/cities');
sinon.stub(cities, 'ensure_data', ()=>null);
const Timeline = require('../lib/timeline.js');
const zlog = require('../lib/log.js');
const etask = require('../util/etask.js');
const pkg = require('../package.json');
const qw = require('../util/string.js').qw;
const lpm_util = require('../util/lpm_util.js');
const assign = Object.assign;
const customer = 'abc';
const password = 'xyz';
const {assert_has} = require('./common.js');
const api_base = 'https://'+pkg.api_domain;

let tmp_file_counter = 0;
const temp_file_path = (ext, pre)=>{
    const p = path.join(os.tmpdir(),
        `${pre||'test'}-${Date.now()}-${tmp_file_counter++}.${ext||'tmp'}`);
    const done = ()=>{
        if (this.path)
        {
            try {
                fs.unlinkSync(path);
            } catch(e){}
            this.path = null;
        }
    };
    return {path: p, done: done};
};

const temp_file = (content, ext, pre)=>{
    const temp = temp_file_path(ext, pre);
    fs.writeFileSync(temp.path, JSON.stringify(content));
    return temp;
};

describe('manager', ()=>{
    const log_stub = sinon.stub(zlog._log, 'push');
    let app, temp_files;
    const get_param = (args, param)=>{
        let i = args.indexOf(param)+1;
        return i ? args[i] : null;
    };
    const app_with_args = (args, only_explicit)=>etask(function*(){
        let manager;
        this.finally(()=>{
            if (this.error && manager)
                return manager.stop(true);
        });
        args = args||[];
        const www = get_param(args, '--www')||Manager.default.www;
        if (!only_explicit)
        {
            let log = get_param(args, '--log');
            if (!log)
                args = args.concat(['--log', 'NONE']);
            if (!get_param(args, '--proxy'))
                args = args.concat(['--proxy', '127.0.0.1']);
            if (!get_param(args, '--proxy_port'))
                args = args.concat(['--proxy_port', 24000]);
            if (!get_param(args, '--config')&&!get_param(args, '--no-config'))
                args.push('--no-config');
            if (!get_param(args, '--customer'))
                args = args.concat(['--customer', customer]);
            if (!get_param(args, '--password'))
                args = args.concat(['--password', password]);
            if (!get_param(args, '--dropin'))
                args = args.concat(['--no-dropin']);
            if (!get_param(args, '--cookie')&&!get_param(args, '--no-cookie'))
                args.push('--no-cookie');
            if (!get_param(args, '--local_login'))
                args = args.concat(['--no-local_login']);
            args = args.concat('--loki', '/tmp/testdb');
        }
        Manager.prototype.check_conn = ()=>null;
        manager = new Manager(lpm_util.init_args(args));
        manager.on('error', this.throw_fn());
        yield manager.start();
        const admin = 'http://127.0.0.1:'+www;
        return {manager, admin};
    });
    const app_with_config = opt=>etask(function*(){
        const args = [];
        const cli = opt.cli||{};
        Object.keys(cli).forEach(k=>{
            if (typeof cli[k]=='boolean')
            {
                if (cli[k])
                    args.push('--'+k);
                else
                    args.push('--no-'+k);
                return;
            }
            args.push('--'+k);
            args.push(cli[k]);
        });
        if (opt.config)
        {
            const config_file = temp_file(opt.config||[], 'json');
            args.push('--config');
            args.push(config_file.path);
            temp_files.push(config_file);
        }
        (opt.files||[]).forEach(c=>{
            const file = temp_file(c, 'json');
            args.push(file.path);
            temp_files.push(file);
        });
        return yield app_with_args(args, opt.only_explicit);
    });
    const app_with_proxies = (proxies, cli)=>etask(function*(){
        return yield app_with_config({config: {proxies}, cli});
    });
    const api = (_path, method, data, json)=>etask(function*(){
        const opt = {
            url: app.admin+'/'+_path,
            method: method||'GET',
            json: json,
            body: data,
        };
        return yield etask.nfn_apply(request, [opt]);
    });
    const api_json = (_path, options)=>etask(function*(){
        let opt = options||{};
        return yield api(_path, opt.method, opt.body, true);
    });
    const json = (_path, method, data)=>etask(function*(){
        const res = yield api(_path, method, data, true);
        assert.equal(res.statusCode, 200);
        return res.body;
    });
    afterEach('after manager', etask._fn(function*(_this){
        if (!app)
            return;
        yield app.manager.stop(true);
        if (process.platform=='win32')
            yield etask.sleep(10);
        if (!app)
            return;
        app = null;
    }));
    beforeEach(()=>temp_files = []);
    afterEach('after manager 2', ()=>temp_files.forEach(f=>f.done()));
    describe('get_params', ()=>{
        const t = (name, _args, expected)=>it(name, etask._fn(function(_this){
            const mgr = new Manager(lpm_util.init_args(_args));
            assert.deepEqual(expected, mgr.get_params());
        }));
        t('default', qw`--foo 1 --bar 2`, ['--foo', 1, '--bar', 2]);
        t('credentials',
            qw`--foo 1 --bar 2 --customer test_user --password abcdefgh`,
            ['--foo', 1, '--bar', 2]);
        t('credentials with no-config',
            qw`--no-config --customer usr --password abc --token t --zone z`,
            qw`--no-config --customer usr --password abc --token t --zone z`);
    });
    xdescribe('config load', ()=>{
        const t = (name, config, expected)=>it(name, etask._fn(
        function*(_this){
            app = yield app_with_config(config);
            let proxies = yield json('api/proxies_running');
            assert_has(proxies, expected, 'proxies');
        }));
        const simple_proxy = {port: 24024};
        t('cli only', {cli: simple_proxy, config: []},
            [assign({}, simple_proxy, {proxy_type: 'persist'})]);
        t('main config only', {config: simple_proxy},
            [assign({}, simple_proxy, {proxy_type: 'persist'})]);
        t('config file', {files: [simple_proxy]}, [simple_proxy]);
        t('config override cli', {cli: simple_proxy, config: {port: 24042}},
            [simple_proxy, {proxy_type: 'persist', port: 24042}]);
        const multiple_proxies = [
            assign({}, simple_proxy, {port: 25025}),
            assign({}, simple_proxy, {port: 26026}),
            assign({}, simple_proxy, {port: 27027}),
        ];
        t('multiple config files', {files: multiple_proxies},
            multiple_proxies);
        t('main + config files', {config: simple_proxy,
            files: multiple_proxies}, [].concat([assign({}, simple_proxy,
            {proxy_type: 'persist'})], multiple_proxies));
        describe('default zone', ()=>{
            const zone_static = {password: ['pass1']};
            const zone_gen = {password: ['pass2']};
            const zones = {static: assign({}, zone_static),
                gen: assign({}, zone_gen)};
            const t2 = (name, config, expected, _defaults={zone: 'static'})=>{
                nock(api_base).get('/').reply(200, {});
                nock(api_base).post('/update_lpm_stats').reply(200, {});
                nock(api_base).get('/cp/lum_local_conf')
                    .query({customer: 'testc1', proxy: pkg.version})
                    .reply(200, {_defaults});
                t(name, _.set(config, 'cli.customer', 'testc1'), expected);
            };
            t2('invalid', {config: {_defaults: {zone: 'foo'},
                proxies: [simple_proxy]}}, [assign({}, simple_proxy,
                {zone: 'static'})], {zone: 'static', zones});
            t2('keep default', {config: {_defaults: {zone: 'gen'},
                proxies: [simple_proxy]}}, [assign({}, simple_proxy,
                {zone: 'gen'})]);
            t2('default disabled', {config: {_defaults: {zone: 'gen'},
                proxies: [simple_proxy]}}, [assign({}, simple_proxy,
                {zone: 'static'})], {zone: 'static', zones: assign({}, zones,
                    {gen: {plan: {disable: 1}}})});
        });
    });
    xdescribe('dropin', ()=>{
        const t = (name, args, expected)=>it(name, etask._fn(
        function*(_this){
            app = yield app_with_args(args);
            let proxies = yield json('api/proxies_running');
            assert_has(proxies, expected, 'proxies');
        }));
        t('off', ['--no-dropin'], []);
    });
    describe('api', ()=>{
        it('ssl', etask._fn(function*(_this){
            app = yield app_with_args();
            const res = yield api('ssl');
            assert_has(res.headers, {
                'content-type': 'application/x-x509-ca-cert',
                'content-disposition': 'filename=luminati.crt',
            }, 'headers');
            assert.equal(res.body, fs.readFileSync(path.join(__dirname,
                '../bin/ca.crt')), 'certificate');
        }));
        describe('version info', ()=>{
            it('current', ()=>etask(function*(){
                app = yield app_with_args();
                const body = yield json('api/version');
                assert.equal(body.version, pkg.version);
            }));
        });
        describe('proxies', ()=>{
            describe('get', ()=>{
                it('normal', ()=>etask._fn(function*(_this){
                    const proxies = [{port: 24023}, {port: 24024}];
                    app = yield app_with_proxies(proxies);
                    let res = yield json('api/proxies');
                    assert_has(res, proxies, 'proxies');
                    res = yield json('api/proxies_running');
                    assert_has(res, proxies, 'proxies_running');
                }));
            });
            describe('post', ()=>{
                it('normal non-persist', ()=>etask._fn(function*(_this){
                    const sample_proxy = {
                        port: 24001,
                        proxy_type: 'non-persist',
                    };
                    const proxies = [{port: 24000}];
                    app = yield app_with_proxies(proxies, {});
                    let res = yield json('api/proxies', 'post',
                        {proxy: sample_proxy});
                    assert_has(res, {data: sample_proxy}, 'proxies');
                    res = yield json('api/proxies_running');
                    assert_has(res, [{}, sample_proxy], 'proxies');
                    res = yield json('api/proxies');
                    assert.equal(res.length, 1);
                }));
                it('normal persist', etask._fn(function*(_this){
                    let sample_proxy = {port: 24001};
                    let proxies = [{port: 24000}];
                    app = yield app_with_proxies(proxies, {});
                    let res = yield json('api/proxies', 'post',
                        {proxy: sample_proxy});
                    assert_has(res, {data: sample_proxy}, 'proxies');
                    res = yield json('api/proxies_running');
                    assert_has(res, [{}, sample_proxy], 'proxies');
                    res = yield json('api/proxies');
                    assert_has(res, [{}, sample_proxy], 'proxies');
                }));
                it('inherit defaults', ()=>etask(function*(){
                    const sample_proxy = {port: 24001, proxy_type:
                        'non-persist'};
                    const res_proxy = assign({}, {customer, password},
                        sample_proxy);
                    app = yield app_with_proxies([{port: 24000}], {});
                    let res = yield json('api/proxies', 'post',
                        {proxy: sample_proxy});
                    assert_has(res, {data: res_proxy}, 'proxies');
                    res = yield json('api/proxies_running');
                    assert_has(res, [{}, res_proxy], 'proxies');
                    res = yield json('api/proxies');
                    assert.equal(res.length, 1);
                }));
                it('conflict', etask._fn(function*(_this){
                    const sample_proxy = {port: 24000};
                    const proxies = [sample_proxy];
                    app = yield app_with_proxies(proxies, {});
                    const res = yield api_json('api/proxies',
                        {method: 'post', body: {proxy: sample_proxy}});
                    assert.equal(res.statusCode, 400);
                    assert_has(res.body, {errors: []}, 'proxies');
                }));
            });
            describe('put', ()=>{
                it('normal', etask._fn(function*(_this){
                    const put_proxy = {port: 24001};
                    const proxies = [{port: 24000}];
                    app = yield app_with_proxies(proxies, {});
                    let res = yield json('api/proxies/24000', 'put',
                        {proxy: put_proxy});
                    assert_has(res, {data: put_proxy});
                    res = yield json('api/proxies_running');
                    assert_has(res, [put_proxy], 'proxies');
                }));
                it('inherit defaults', ()=>etask(function*(){
                    const put_proxy = {port: 24001};
                    const proxies = [{port: 24000}];
                    const res_proxy = assign({}, {customer, password},
                        put_proxy);
                    app = yield app_with_proxies(proxies, {});
                    let res = yield json('api/proxies/24000', 'put',
                        {proxy: put_proxy});
                    assert_has(res, {data: res_proxy});
                    res = yield json('api/proxies_running');
                    assert_has(res, [res_proxy], 'proxies');
                }));
                it('conflict', etask._fn(function*(_this){
                    let proxies = [{port: 24000}, {port: 24001}];
                    app = yield app_with_proxies(proxies, {});
                    let res = yield api_json('api/proxies/24001',
                        {method: 'put', body: {proxy: {port: 24000}}});
                    assert.equal(res.statusCode, 400);
                    assert_has(res.body, {errors: []}, 'proxies');
                }));
            });
            describe('delete', ()=>{
                it('normal', etask._fn(function*(_this){
                    app = yield app_with_args([]);
                    let res = yield api_json('api/proxies/24000',
                        {method: 'delete'});
                    assert.equal(res.statusCode, 204);
                }));
            });
        });
        describe('user credentials', ()=>{
            it('success', etask._fn(function*(_this){
                nock(api_base).get('/').times(3).reply(200, {});
                nock(api_base).post('/update_lpm_stats').reply(200, {});
                nock(api_base).post('/update_lpm_config').reply(200, {});
                nock(api_base).get('/cp/lum_local_conf').query(true)
                    .reply(200, {mock_result: true, _defaults: true});
                app = yield app_with_args(['--customer', 'mock_user']);
                const res = yield app.manager.get_lum_local_conf(null, '123');
                assert_has(res, {mock_result: true});
            }));
            it('login required', etask._fn(function*(_this){
                nock(api_base).get('/').times(3).reply(200, {});
                nock(api_base).get('/cp/lum_local_conf')
                    .query(true)
                    .reply(403, 'login_required');
                nock(api_base).get('/cp/lum_local_conf').times(2)
                    .query(true)
                    .reply(403, 'login_required');
                app = yield app_with_args(['--customer', 'mock_user']);
                try {
                    yield app.manager.get_lum_local_conf(null, '123');
                    assert.fail('should have thrown exception');
                } catch(e){
                    assert_has(e, {status: 403, message: 'login_required'});
                }
            }));
        });
        describe('har logs', ()=>{
            it('fetches all the logs', etask._fn(function*(_this){
                app = yield app_with_args(['--customer', 'mock_user',
                    '--port', '24000']);
                app.manager.loki.requests_clear();
                app.manager.proxies_running[24000].usage({
                    timeline: new Timeline(),
                    request: {url: 'http://bbc.com'},
                    response: {},
                });
                const res = yield api_json(`api/logs_har`);
                assert_has(res.body.log.entries[0],
                    {request: {url: 'http://bbc.com'}});
                assert.equal(res.body.log.entries.length, 1);
            }));
        });
        xdescribe('recent_stats', ()=>{
            const t = (name, expected)=>
            it(name, etask._fn(function*(_this){
                nock(api_base).get('/cp/lum_local_conf')
                    .query({customer: 'mock_user', proxy: pkg.version})
                    .reply(200, {mock_result: true, _defaults: true});
                app = yield app_with_args(qw`--customer mock_user --port 24000
                    --request_stats --ssl false`);
                app.manager.loki.stats_clear();
                yield etask.nfn_apply(request, [{
                    proxy: 'http://127.0.0.1:24000',
                    url: 'http://linkedin.com/',
                    strictSSL: false,
                }]);
                yield etask.sleep(1500);
                const res = yield api_json(`api/recent_stats`);
                assert_has(res.body, expected);
            }));
            t('main', {
                status_code: [{key: '200', reqs: 1}],
                protocol: [{key: 'http', reqs: 1}],
                hostname: [{key: 'linkedin.com', reqs: 1}],
                ports: {24000: {
                    reqs: 1,
                    success: 1,
                    url: 'http://linkedin.com/',
                }},
                success: 1,
                total: 1,
            });
        });
    });
    describe('crash on load error', ()=>{
        beforeEach(()=>{
            log_stub.reset();
        });
        const t = (name, proxies, msg)=>it(name, etask._fn(function*(_this){
            const err_matcher = sinon.match(msg);
            app = yield app_with_proxies(proxies);
            sinon.assert.calledWith(log_stub, err_matcher);
        }));
        t('conflict proxy port', [{port: 24024}, {port: 24024}],
            'Port 24024 is already in use by Proxy #1 - skipped');
        const www_port = Manager.default.www;
        t('conflict with www', [{port: www_port}],
            `Port ${www_port} is already in use by UI/API - skipped`);
    });
    describe('using passwords', ()=>{
        it('take password from provided zone', etask._fn(function*(_this){
            const config = {proxies: []};
            const _defaults = {zone: 'static', password: 'xyz',
                zones: {zone1: {password: ['zone1_pass']}}};
            nock(api_base).get('/cp/lum_local_conf').query(true)
                .reply(200, {_defaults});
            nock(api_base).post('/update_lpm_stats').query(true)
                .reply(200, {});
            nock(api_base).post('/update_lpm_config').query(true)
                .reply(200, {});
            app = yield app_with_config({config, cli: {token: '123'}});
            const res = yield json('api/proxies', 'post',
                {proxy: {port: 24000, zone: 'zone1'}});
            assert.equal(res.data.password, 'zone1_pass');
        }));
        it('uses password from default zone', etask._fn(function*(_this){
            const config = {proxies: []};
            const _defaults = {zone: 'static', password: 'xyz',
                zones: {static: {password: ['static_pass']}}};
            nock(api_base).get('/').times(3).reply(200, {});
            nock(api_base).get('/cp/lum_local_conf').query(true)
                .reply(200, {_defaults});
            nock(api_base).post('/update_lpm_stats').query(true)
                .reply(200, {});
            nock(api_base).post('/update_lpm_config').query(true)
                .reply(200, {});
            app = yield app_with_config({config, cli: {token: '123'}});
            const res = yield json('api/proxies', 'post',
                {proxy: {port: 24000, zone: 'static'}});
            assert.equal(res.data.password, 'static_pass');
        }));
        it('uses new proxy custom password', etask._fn(function*(_this){
            const config = {proxies: []};
            const _defaults = {zone: 'static', password: 'xyz',
                zones: {static: {password: ['static_pass']}}};
            app = yield app_with_config({config, cli: {}});
            nock(api_base).get('/cp/lum_local_conf')
            .query({customer: 'abc', proxy: pkg.version, token: ''})
            .reply(200, {_defaults});
            const res = yield json('api/proxies', 'post',
                {proxy: {port: 24000, zone: 'static', password: 'p1_pass'}});
            assert.equal(res.data.password, 'p1_pass');
        }));
        it('uses existing proxy custom password', etask._fn(function*(_this){
            const _defaults = {
                zone: 'static',
                password: 'xyz',
                zones: {
                    static: {password: ['static_pass']},
                    zone2: {password: ['zone2_pass']},
                },
            };
            nock(api_base).get('/').times(3).reply(200, {});
            nock(api_base).get('/cp/lum_local_conf').query(true)
                .reply(200, {_defaults});
            nock(api_base).post('/update_lpm_stats').query(true)
                .reply(200, {});
            nock(api_base).post('/update_lpm_config').query(true)
                .reply(200, {});
            const config = {proxies: [
                {port: 24000, zone: 'static', password: 'p1_pass'},
                {port: 24001, zone: 'zone2', password: 'p2_pass'},
                {port: 24002, zone: 'static'},
                {port: 24003, zone: 'zone2'},
                {port: 24004},
                {port: 24005, zone: 'unknown', password: 'p3_pass'},
            ]};
            app = yield app_with_config({config, cli: {token: '123'}});
            const res = yield json('api/proxies_running');
            assert.equal(res.find(p=>p.port==24000).password, 'static_pass');
            assert.equal(res.find(p=>p.port==24001).password, 'zone2_pass');
            assert.equal(res.find(p=>p.port==24002).password, 'static_pass');
            assert.equal(res.find(p=>p.port==24003).password, 'zone2_pass');
            assert.equal(res.find(p=>p.port==24004).password, 'static_pass');
            assert.equal(res.find(p=>p.port==24005).password, 'p3_pass');
        }));
    });
    describe('flags', ()=>{
        it('exits immediately with version on -v', etask._fn(function*(_this){
            const exec = require('child_process').execFile;
            exec('node', ['./bin/index.js', '--version'], (err, res)=>{
                this.continue();
                assert.equal(res, pkg.version+'\n');
            });
            yield this.wait();
        }));
    });
    describe('whitelisting', ()=>{
        it('takes whitelist ips from cmd', etask._fn(function*(_this){
            app = yield app_with_proxies([{port: 24000}],
                {whitelist_ips: '1.2.3.4'});
            const {whitelist_ips} = app.manager.proxies_running[24000].opt;
            assert.equal(whitelist_ips.length, 1);
            assert.equal(whitelist_ips[0], '1.2.3.4');
        }));
    });
    xdescribe('migrating', ()=>{
        beforeEach(()=>{
            log_stub.reset();
        });
        const t = (name, should_run_migrations, config={}, cli={})=>
        it(name, etask._fn(function*(_this){
            const notice = 'NOTICE: Migrating config file 1.116.387';
            const first_migration_match = sinon.match(notice);
            app = yield app_with_config({config, cli});
            if (should_run_migrations)
                sinon.assert.calledWith(log_stub, first_migration_match);
            else
                sinon.assert.neverCalledWith(log_stub, first_migration_match);
        }));
        t('should run migrations if config file exists and version is old',
            true, {proxies: [{}]});
        t('should not run migrations if --no-config flag is passed',
            false, {proxies: [{}]}, {'no-config': true});
        t('should not run migrations if config does not exist', false);
        t('should not run migrations if config exists and version is new',
            false, {_defaults: {version: '1.120.0'}});
    });
});

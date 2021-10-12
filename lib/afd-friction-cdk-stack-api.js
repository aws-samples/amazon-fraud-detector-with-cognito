/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const cdk =  require('@aws-cdk/core');
const lambda = require('@aws-cdk/aws-lambda');
const iam = require('@aws-cdk/aws-iam');
const apigateway = require('@aws-cdk/aws-apigateway');
const { Model } = require('@aws-cdk/aws-apigateway');
const genApiKey = require('./gen-api-key')
require('dotenv').config();

class AfdFrictionAPIStack extends cdk.Stack {
    /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
    constructor(scope, id, props) {
        super(scope, id, props);

        const lamdaRoleArn = cdk.Fn.importValue('lambda-exec-role');
        const afdTableName = cdk.Fn.importValue('afd-dd-table-name-new');

        // import existing Lambda Role
        const lambdaRole = iam.Role.fromRoleArn(
            this,
            'imported-lambda-role',
            lamdaRoleArn,
            {mutable: false},
        );

        // Lmabda function for API Gateway
        const IpUserAgentLambda = new lambda.Function(this, 'afd-ip-user-agent', {
            code: new lambda.AssetCode('src/afd-ip-user-agent'),
            handler: 'afd-ip-user-agent.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            functionName: 'afd-ip-user-agent',
            description: 'Amazon Fraud Detector- IP and User Agent Lambda',      
            role: lambdaRole
        });

        // Post sign-up verification Lambda for API Gateway
        const verificationLambda = new lambda.Function(this, 'afd-post-signup-verification', {
            code: new lambda.AssetCode('src/afd-post-signup-verification'),
            handler: 'afd-post-signup-verification.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            functionName: 'afd-post-signup-verification',
            description: 'Amazon Fraud Detector- Post Signup Verification Lambda',      
            role: lambdaRole,
            environment:{
                AFD_DETECTOR: `${process.env.AFD_DETECTOR_NAME}`,
                AFD_ENTITY_TYPE: `${process.env.AFD_ENTITY_TYPE}`,
                AFD_EVENT_TYPE: `${process.env.AFD_EVENT_TYPE}`,
                AFD_DETECTOR_VERSION: `${process.env.AFD_DETECTOR_VERSION}`,                
                USER_TABLE: afdTableName
            }
        });

        //Define API Gateway CorsOptions
        const corsOptions = {
            defaultCorsPreflightOptions: {
            allowOrigins: apigateway.Cors.ALL_ORIGINS,
            allowMethods: apigateway.Cors.ALL_METHODS, // this is also the default
            statusCode: 200
          }
        }

        //setup LambdaRestAPI
        const appAPI = new apigateway.LambdaRestApi(this, 'afd-lambda-rest-api',{       
                                    handler: IpUserAgentLambda,                              
                                    proxy: false,
                                    deployOptions: {
                                        loggingLevel: apigateway.MethodLoggingLevel.INFO,
                                        dataTraceEnabled: true
                                    }
                                });

        const app = appAPI.root.addResource('app', corsOptions);
        const ipua = app.addResource('ipua', corsOptions);

        const verify = app.addResource('verify', corsOptions);
        const verifyInteg = new apigateway.LambdaIntegration(verificationLambda);

        //Define the Lambda Integration
        // const ipuaIntegration = new apigateway.LambdaIntegration(IpUserAgentLambda);

        const ipuaGetMethod = ipua.addMethod('GET', 
                        undefined, 
                        { 
                            apiKeyRequired: true,                         
                            methodResponses: [
                                    { 
                                        statusCode: '200' ,
                                        responseModels: {
                                            'application/json': Model.EMPTY_MODEL
                                        }
                                    },
                                    { 
                                        statusCode: '400' ,
                                        responseModels: {
                                            'application/json': Model.ERROR_MODEL
                                        }
                                    }
                                ] 
                        });

        const verifyPostMethod = verify.addMethod('POST',
                                            verifyInteg,
                                            { 
                                                apiKeyRequired: true,                           
                                                methodResponses: [
                                                        { statusCode: '200' ,
                                                            responseModels: {
                                                                'application/json': Model.EMPTY_MODEL
                                                            }
                                                        },
                                                        { statusCode: '400' ,
                                                            responseModels: {
                                                                'application/json': Model.ERROR_MODEL
                                                            }
                                                        }
                                                    ] 
                                            });
        
        //Add an API Gateway Usage Plan
        const plan = appAPI.addUsagePlan('UsagePlan', {
            name: 'afd-api-usg-plan',
            throttle: {
              rateLimit: 100,
              burstLimit: 2
            }
        });

        //Add an API Key
        //Generate an API Key
        const hash = genApiKey();
        const key = appAPI.addApiKey('ApiKey', {
            apiKeyName: `afd-usage-plan-api-key-${Date.now()}`,
            value: hash
        });
        plan.addApiKey(key);

        //Add API Endpoint Throttle
        plan.addApiStage({
            stage: appAPI.deploymentStage,
            throttle: [
              {
                method: ipuaGetMethod,
                throttle: {
                  rateLimit: 100,
                  burstLimit: 2
                }
              },
              {
                method: verifyPostMethod,
                throttle: {
                  rateLimit: 100,
                  burstLimit: 2
                }
              }
            ]
        });

        //export Api endpoint
        new cdk.CfnOutput(this, 'endpoint', {
            value: appAPI.url,
            description: 'Endpoint URL',
            exportName: 'endpoint',
        });

        //export Api endpoint
        new cdk.CfnOutput(this, 'apikey', {
            value: hash,
            description: 'Endpoint Api Key',
            exportName: 'apikey',
        });

    }
}

module.exports = { AfdFrictionAPIStack }
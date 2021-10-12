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

const cdk = require('@aws-cdk/core');
const cognito = require('@aws-cdk/aws-cognito');
const lambda = require('@aws-cdk/aws-lambda');
const iam = require('@aws-cdk/aws-iam');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const { TableEncryption } = require('@aws-cdk/aws-dynamodb');
const { getPolicies } = require('../config/iam-policies');
require('dotenv').config();

class AfdFrictionCdkStack extends cdk.Stack {
  static lambdaRoleArn;

  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    //Get IAM Policies
    const policies = getPolicies();

    // Custom IAM Role for Lambda Functions
    const CustomRole = new iam.Role(this, 'afd-Lambda-Execution-Role-1',{
      roleName: 'afd-Lambda-Execution-Role-1',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: policies
    });

    // export Lambda Role for cross-stack reference
    new cdk.CfnOutput(this, 'lambda-exec-role-ref', {
      value: CustomRole.roleArn,
      description: 'Lambda Role ARN',
      exportName: 'lambda-exec-role',
    });

    const afdUserTableNew = new dynamodb.Table(this, 'afd-user-signup-scores-tbl', {
      partitionKey: {
        name: 'EMAIL',
        type: dynamodb.AttributeType.STRING
      },
      tableName: 'afd-user-signup-scores-tbl',
      encryption: TableEncryption.AWS_MANAGED,
      // The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
      // the new table, and it will remain in your account until manually deleted. By setting the policy to 
      // DESTROY, cdk destroy will delete the table (even if it has data in it)
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // export Table name for cross-stack reference
    new cdk.CfnOutput(this, 'afd-dd-table-name-new', {
      value: afdUserTableNew.tableName,
      description: 'DynamoDB Table Name',
      exportName: 'afd-dd-table-name-new',
    });

    // Lmabda Pre-Signup Trigger
    const preSignUpLambda = new lambda.Function(this, 'afd-cog-pre-signup', {
      code: new lambda.AssetCode('src/afd-cog-pre-signup'),
      handler: 'afd-cog-pre-signup.handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      functionName: 'afd-cog-pre-signup',
      description: 'Amazon Fraud Detector- Cognito Pre-signup Trigger',      
      role: CustomRole,
      environment: {
        AFD_DETECTOR: `${process.env.AFD_DETECTOR_NAME}`,
        AFD_ENTITY_TYPE: `${process.env.AFD_ENTITY_TYPE}`,
        AFD_EVENT_TYPE: `${process.env.AFD_EVENT_TYPE}`,
        AFD_DETECTOR_VERSION: `${process.env.AFD_DETECTOR_VERSION}`,
        USER_TABLE: afdUserTableNew.tableName
      }      
    });

    // User Pool
    const userPool = new cognito.UserPool(this, 'afd-userpool', {
      userPoolName: 'afd-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
        email:{
          required: true,
          mutable: false
        }
      },
      customAttributes: {
        registration_ip: new cognito.StringAttribute({mutable: true}),
        reg_user_agent: new cognito.StringAttribute({mutable: true}),
        billing_postal: new cognito.StringAttribute({mutable: true}),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lambdaTriggers:{
        preSignUp: preSignUpLambda
      }
    });

    //export user pool id
    new cdk.CfnOutput(this, 'userPoolId', {
      value: userPool.userPoolId,
      description: 'User Pool ID',
      exportName: 'userPoolId',
    });

    // User Pool Client Attributes
    const standardCognitoAttributes = {
          address: true,
          email: true,
          familyName: true,
          givenName: true,
          locale: true,
          phoneNumber: true          
    };

    const clientReadAttributes = new cognito.ClientAttributes()
    .withStandardAttributes(standardCognitoAttributes)
    .withCustomAttributes(...['registration_ip', 'reg_user_agent', 'billing_postal']);

    const clientWriteAttributes = new cognito.ClientAttributes()
    .withStandardAttributes(standardCognitoAttributes)
    .withCustomAttributes(...['registration_ip', 'reg_user_agent', 'billing_postal']);

    const client = userPool.addClient('afd-app-client', {
      enableTokenRevocation: true,
      generateSecret: false,
      authFlows:{        
        adminUserPassword: false,
        custom: true,
        userPassword: false,
        userSrp: true
      },      
      readAttributes: clientReadAttributes,
      writeAttributes: clientWriteAttributes,
      oAuth:{
        flows:{
          authorizationCodeGrant: true
        },
        scopes:[cognito.OAuthScope.EMAIL, cognito.OAuthScope.PHONE, cognito.OAuthScope.PROFILE, cognito.OAuthScope.OPENID]
      }
    });
    const clientId = client.userPoolClientId;

    //export web client id
    new cdk.CfnOutput(this, 'userPoolWebClientId', {
      value: clientId,
      description: 'User Pool Web Client ID',
      exportName: 'userPoolWebClientId',
    });

    // Add permission Lambda as an inline policy with the cognito ARN
    preSignUpLambda.role.attachInlinePolicy(new iam.Policy(this, 'afd-userpool-policy', {
      statements: [ new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPool'],
        resources: [userPool.userPoolArn],
      }) ]
    }));

    //Create a Cognito Identity Pool
    const identityPool = new cognito.CfnIdentityPool(this, 'afd-identity-pool', {
      identityPoolName: 'afd_friction_identity_pool',
      allowUnauthenticatedIdentities: true,
      cognitoIdentityProviders: [
        {
          clientId: clientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    //export Identity id
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Identity Pool  ID',
      exportName: 'IdentityPoolId',
    });

    //Create Unauth and Auth Roles for the identity pool
    const identityUnauthRole = new iam.Role(
      this,
      'afd-cognito-unauth-role',
      {
        roleName: 'afd-cognito-unauth-role',
        description: 'Default role for anonymous users',
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'unauthenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity',
        ),
      },
    );

    identityUnauthRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["mobileanalytics:PutEvents", "cognito-sync:*"],
        resources: ["*"],
    }))

    const identityAuthRole = new iam.Role(
      this, 
      'afd-cognito-auth-role', 
      {
        roleName: 'afd-cognito-auth-role',
        description: 'Default role for authenticated users',
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity',
        ),
    });

    identityAuthRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["mobileanalytics:PutEvents",
                    "cognito-sync:*",
                    "cognito-identity:*"],
        resources: ["*"],
    }))

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      'identity-pool-role-attachment',
      {
        identityPoolId: identityPool.ref,
        roles: {
          authenticated: identityAuthRole.roleArn,
          unauthenticated: identityUnauthRole.roleArn,
        },
      },
    );
    
    //export User Pool Region
    new cdk.CfnOutput(this, 'region', {
      value: process.env.AWS_REGION,
      description: 'User Pool Region',
      exportName: 'region',
    });
  }
}

module.exports = { AfdFrictionCdkStack }

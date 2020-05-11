'use strict';

import React from 'react';
import {Redirect} from 'react-router';

import Character from '../../models/Character';
import FarmCharacter from '../../models/FarmCharacter';
import FarmHelper from '../../helpers/FarmHelper';
import EveCountdownTimer from '../widgets/EveCountdownTimer';

import Avatar from 'material-ui/Avatar';
import {Table, TableHeader, TableHeaderColumn, TableBody, TableRow, TableRowColumn} from 'material-ui/Table';
import IconButton from 'material-ui/IconButton';
import FontIcon from 'material-ui/FontIcon';
import {red500} from 'material-ui/styles/colors';

const styles = {
    charactersTable: {
        height: '100%',
        width: '100%'
    },
    omegaStatusIcon: {
        marginTop: '5px'
    }
};

export default class SpFarmingTable extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            characters: Object.values(FarmCharacter.getAll()).sort((a, b) => {
                var charA = Character.get(a.id);
                var charB = Character.get(b.id);

                var countSort = charB.getInjectorsReady(b.baseSp) - charA.getInjectorsReady(a.baseSp);  // Descending
                
                const MAX_DATE = new Date(8640000000000000);
                var nextCharB = charB.getNextInjectorDate(b.baseSp) || MAX_DATE;
                var nextCharA = charA.getNextInjectorDate(a.baseSp) || MAX_DATE;
                var timeSort = nextCharA - nextCharB;  // Ascending

                return countSort || timeSort || MAX_DATE;
            }),
            injectorsReady: Object.values(FarmCharacter.getAll()).reduce((count, char) => {
                return count + (Character.get(char.id).getInjectorsReady(char.baseSp));
            }, 0),
            redirectPath: undefined
        };
    }

    componentDidMount() {
        this.subscriberId = FarmCharacter.subscribe(this);
    }

    componentWillUnmount() {
        FarmCharacter.unsubscribe(this.subscriberId);
    }

    handleClick(e, characterId) {
        let path = '/characters/' + characterId;

        this.setState({
            redirectPath: path
        });
    }

    handleDelete(e, characterId) {
        FarmHelper.deleteFarm(characterId);

        this.forceUpdate();
    }

    renderSpHour(char)
    {
        const spHour = char.getCurrentSpPerHour();
        const maxSpHour = char.getMaxSpPerHour();
        const spWarning = `Not training at max speed!  Could be ${maxSpHour.toLocaleString()} SP/hour`;

        return (<span>{spHour < maxSpHour && <span title={spWarning}>⚠ </span>}{spHour.toLocaleString()}</span>);
    }

    render() {
        if (this.state.redirectPath !== undefined) {
            this.setState({redirectPath: undefined});

            return <Redirect push to={this.state.redirectPath}/>;
        }

        return (
            <Table style={styles.charactersTable}>
                <TableHeader displaySelectAll={false} adjustForCheckbox={false} enableSelectAll={false}>
                    <TableRow>
                        <TableHeaderColumn style={{width: '20px'}}/>
                        <TableHeaderColumn style={{width: '20px'}}/>
                        <TableHeaderColumn style={{width: '20px'}}/>
                        <TableHeaderColumn>Character</TableHeaderColumn>
                        <TableHeaderColumn>
                            Base SP<br/>
                            Total SP
                        </TableHeaderColumn>
                        <TableHeaderColumn>
                            {this.state.injectorsReady} Injectors Ready<br/>
                            Time Until Next Injector
                        </TableHeaderColumn>
                        <TableHeaderColumn>
                            Current SP/hour<br/>
                            Queue Length
                        </TableHeaderColumn>
                        <TableHeaderColumn style={{width: 20}}/>
                    </TableRow>
                </TableHeader>

                <TableBody displayRowCheckbox={false}>
                    {this.state.characters.map(farmChar => {
                        const char = Character.get(farmChar.id);
                        let omegaStatusIconPath = './../resources/';
                        switch(char.isOmega()) {
                            case true:
                                omegaStatusIconPath += 'omega.png';
                                break;
                            case false:
                                omegaStatusIconPath += 'alpha.png';
                                break;
                            default:
                                omegaStatusIconPath = '';
                        }
                        const currentSkill = char.getCurrentSkill();

                        return (
                            <TableRow key={char.id} selectable={false}>
                                <TableRowColumn style={{width: '20px'}}>
                                    <Avatar src={char.portraits.px128x128} style={{marginTop: 5}}/>
                                </TableRowColumn>

                                <TableRowColumn style={{width: '20px'}}>
                                    <img src={omegaStatusIconPath} style={{marginTop: 5}}/>
                                </TableRowColumn>

                                <TableRowColumn style={{width: '20px'}}>
                                    <img src={`https://image.eveonline.com/Corporation/${char.corporation_id}_64.png`} width={35} style={{marginTop: 7}}/>
                                </TableRowColumn>

                                <TableRowColumn><a onClick={e => this.handleClick(e, char.id)}>{char.name}</a></TableRowColumn>

                                <TableRowColumn>
                                    {farmChar.baseSp.toLocaleString(navigator.language, { maximumFractionDigits: 0 })} SP<br/>
                                    {char.getTotalSp().toLocaleString(navigator.language, { maximumFractionDigits: 0 })} SP
                                </TableRowColumn>

                                <TableRowColumn>
                                    {char.getInjectorsReady(farmChar.baseSp)}<br/>
                                    {<EveCountdownTimer endDate={char.getNextInjectorDate(farmChar.baseSp)} />}
                                </TableRowColumn>

                                <TableRowColumn>
                                    {currentSkill !== undefined ?  this.renderSpHour(char) : "Not Training"}<br/>
                                    {currentSkill !== undefined ? <EveCountdownTimer endDate={new Date(char.getLastSkill().finish_date)} /> : ""}
                                </TableRowColumn>

                                <TableRowColumn style={{width: 20, textAlign: 'right', paddingRight: 40}}>
                                    <IconButton color={red500} onClick={e => this.handleDelete(e, char.id)}>
                                        <FontIcon className="material-icons">delete</FontIcon>
                                    </IconButton>
                                </TableRowColumn>
                            </TableRow>
                        )
                    })}
                </TableBody>
            </Table>
        );
    }
}
